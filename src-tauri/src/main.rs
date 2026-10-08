#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use git2::{
    BranchType,
    Delta,
    DiffFindOptions,
    DiffOptions,
    Oid,
    Patch,
    Repository,
    StatusOptions,
};
use jwalk::{ Parallelism, WalkDir };
use notify::{ EventKind, RecommendedWatcher, RecursiveMode, Watcher };
use serde::{ Deserialize, Serialize };
use std::{
    collections::{ HashMap, HashSet },
    path::{ Path, PathBuf },
    process::Command,
    sync::{ atomic::{ AtomicBool, AtomicU64, AtomicUsize, Ordering }, mpsc, Arc, Mutex },
    thread,
    time::{ Duration, SystemTime, UNIX_EPOCH },
};
use tauri::{ AppHandle, Emitter, Manager, State };

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct RepoInfo {
    path: String,
    name: String,
    branch: String,
    remote: Option<String>,
    remote_web: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    last_commit: Option<i64>,
    dirty: bool,
    unpushed: bool,
    modified: Vec<String>,
    staged: Vec<String>,
    untracked: Vec<String>,
    deleted: Vec<String>,
    conflicted: Vec<String>,
}
#[derive(Clone, Serialize)]
struct CommitInfo {
    id: String,
    short_id: String,
    author: String,
    email: String,
    date: i64,
    committer: String,
    committer_email: String,
    committer_date: i64,
    message: String,
    parents: Vec<String>,
}
#[derive(Clone, Serialize)]
struct FileChange {
    path: String,
    old_path: Option<String>,
    status: String,
    insertions: usize,
    deletions: usize,
    binary: bool,
    truncated: bool,
    patch: String,
}
#[derive(Clone, Serialize)]
struct CommitDetail {
    info: CommitInfo,
    insertions: usize,
    deletions: usize,
    files: Vec<FileChange>,
}
#[derive(Clone, Serialize)]
struct Progress {
    stage: String,
    current: String,
    dirs: usize,
    found: usize,
    done: usize,
    total: usize,
}
struct ScanState {
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}
#[derive(Serialize)]
struct DriveInfo {
    drives: Vec<String>,
    roots: Vec<String>,
}
struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}
#[derive(Default, Serialize, Deserialize)]
struct Cache {
    roots: Vec<String>,
    last_scan: i64,
    repos: Vec<RepoInfo>,
    #[serde(default)] ignore: Vec<String>,
}
#[derive(Clone)]
struct Store {
    file: PathBuf,
    known: Arc<Mutex<HashSet<PathBuf>>>,
    repos: Arc<Mutex<HashMap<String, RepoInfo>>>,
    meta: Arc<Mutex<(Vec<String>, i64)>>,
    save_lock: Arc<Mutex<()>>,
}
#[derive(Serialize)]
struct Startup {
    repos: Vec<RepoInfo>,
    roots: Vec<String>,
    drives: Vec<String>,
    last_scan: i64,
}
#[derive(Hash, PartialEq, Eq)]
enum Ev {
    Repo(PathBuf),
    New(PathBuf),
}
enum Out {
    Upd(RepoInfo),
    Add(RepoInfo),
    Rem(String),
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
impl Store {
    fn load(file: PathBuf) -> Self {
        let c: Cache = std::fs
            ::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        *extra().lock().unwrap() = c.ignore.clone();
        let known = c.repos
            .iter()
            .map(|r| PathBuf::from(&r.path))
            .collect();
        let repos = c.repos
            .into_iter()
            .map(|r| (r.path.clone(), r))
            .collect();
        Store {
            file,
            known: Arc::new(Mutex::new(known)),
            repos: Arc::new(Mutex::new(repos)),
            meta: Arc::new(Mutex::new((c.roots, c.last_scan))),
            save_lock: Arc::new(Mutex::new(())),
        }
    }
    fn all(&self) -> Vec<RepoInfo> {
        let mut v: Vec<_> = self.repos.lock().unwrap().values().cloned().collect();
        v.sort_by_key(|r| r.path.to_lowercase());
        v
    }
    fn save(&self) {
        let _guard = self.save_lock.lock().unwrap();
        let (roots, last_scan) = self.meta.lock().unwrap().clone();
        let c = Cache {
            roots,
            last_scan,
            repos: self.all(),
            ignore: extra().lock().unwrap().clone(),
        };
        if let Ok(b) = serde_json::to_vec(&c) {
            let t = self.file.with_extension("tmp");
            if std::fs::write(&t, b).is_ok() {
                let _ = std::fs::rename(&t, &self.file);
            }
        }
    }
    fn upsert(&self, i: &RepoInfo) -> bool {
        self.known.lock().unwrap().insert(PathBuf::from(&i.path));
        let mut m = self.repos.lock().unwrap();
        let ch = m.get(&i.path) != Some(i);
        if ch {
            m.insert(i.path.clone(), i.clone());
        }
        ch
    }
    fn remove(&self, p: &Path) {
        self.known.lock().unwrap().remove(p);
        self.repos.lock().unwrap().remove(&p.to_string_lossy().into_owned());
    }
    fn replace(&self, list: &[RepoInfo], scanned: &[String]) {
        let mut m = self.repos.lock().unwrap();
        let mut k = self.known.lock().unwrap();
        m.retain(|p, _| {
            let keep = !scanned.iter().any(|r| Path::new(p).starts_with(r));
            if !keep {
                k.remove(Path::new(p));
            }
            keep
        });
        for i in list {
            k.insert(PathBuf::from(&i.path));
            m.insert(i.path.clone(), i.clone());
        }
        let mut meta = self.meta.lock().unwrap();
        for r in scanned {
            if !meta.0.contains(r) {
                meta.0.push(r.clone());
            }
        }
        meta.1 = now();
    }
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}
fn iso_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        for c in b'C'..=b'Z' {
            let p = format!("{}:\\", c as char);
            if Path::new(&p).is_dir() {
                roots.push(PathBuf::from(p));
            }
        }
        if roots.is_empty() {
            if let Ok(h) = std::env::var("USERPROFILE") {
                roots.push(PathBuf::from(h));
            }
        }
        roots
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![PathBuf::from("/")]
    }
}
static EXTRA: std::sync::OnceLock<Mutex<Vec<String>>> = std::sync::OnceLock::new();
fn extra() -> &'static Mutex<Vec<String>> {
    EXTRA.get_or_init(|| Mutex::new(Vec::new()))
}
fn ignored(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    extra().lock().unwrap().contains(&n) ||
        matches!(
            n.as_str(),
            "appdata" |
                "windows" |
                "proc" |
                "sys" |
                "node_modules" |
                ".cargo" |
                ".rustup" |
                ".npm" |
                "$recycle.bin" |
                "system volume information" |
                "programdata" |
                "program files" |
                "program files (x86)" |
                "site-packages" |
                "__pycache__" |
                ".venv" |
                "venv"
        )
}
fn skip(p: &Path) -> bool {
    p
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(false, |n| n.ends_with(".lock")) ||
        p.components().any(|c|
            c
                .as_os_str()
                .to_str()
                .map_or(false, |s| ignored(s) || matches!(s, "target" | "objects"))
        )
}
fn drive_ok(p: &Path) -> bool {
    p.ancestors()
        .last()
        .map_or(false, |r| r.exists())
}
fn prog(
    app: &AppHandle,
    stage: &str,
    current: &str,
    dirs: usize,
    found: usize,
    done: usize,
    total: usize
) {
    let _ = app.emit("scan-progress", Progress {
        stage: stage.into(),
        current: current.into(),
        dirs,
        found,
        done,
        total,
    });
}
fn scan_one(
    root: &Path,
    bg: bool,
    app: &AppHandle,
    cancel: &Arc<AtomicBool>,
    dirs: &Arc<AtomicUsize>,
    found: &Arc<Mutex<Vec<PathBuf>>>
) {
    let (a, c, d, f) = (app.clone(), cancel.clone(), dirs.clone(), found.clone());
    let (t0, last) = (std::time::Instant::now(), Arc::new(AtomicU64::new(0)));
    let walk = WalkDir::new(root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(
            if bg {
                Parallelism::RayonNewPool(2)
            } else {
                Parallelism::RayonDefaultPool { busy_timeout: Duration::from_millis(100) }
            }
        )
        .process_read_dir(move |_, path, _, children| {
            if c.load(Ordering::Relaxed) {
                children.clear();
                return;
            }
            let n = d.fetch_add(1, Ordering::Relaxed) + 1;
            let has_git = children.iter().any(|e| matches!(e,Ok(x) if x.file_name()==".git"));
            let mut count = 0;
            if has_git {
                let mut g = f.lock().unwrap();
                g.push(path.to_path_buf());
                count = g.len();
                let _ = a.emit("scan-found", path.to_string_lossy().into_owned());
            }
            let ms = t0.elapsed().as_millis() as u64;
            let prev = last.load(Ordering::Relaxed);
            if
                (has_git || ms >= prev + 150) &&
                last.compare_exchange(prev, ms, Ordering::Relaxed, Ordering::Relaxed).is_ok()
            {
                prog(
                    &a,
                    "Scanning folders",
                    &path.to_string_lossy(),
                    n,
                    if count > 0 {
                        count
                    } else {
                        f.lock().unwrap().len()
                    },
                    0,
                    0
                );
            }
            children.retain(|e| {
                match e {
                    Ok(x) =>
                        x.file_type().is_dir() &&
                            x
                                .file_name()
                                .to_str()
                                .map(|s| s != ".git" && !ignored(s))
                                .unwrap_or(false),
                    Err(_) => false,
                }
            });
        });
    for _ in walk {
    }
}
fn web_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    let (host, path) = if
        let Some(r) = s
            .strip_prefix("https://")
            .or_else(|| s.strip_prefix("http://"))
            .or_else(|| s.strip_prefix("ssh://"))
            .or_else(|| s.strip_prefix("git://"))
    {
        let r = r
            .rsplit_once('@')
            .filter(|(a, _)| !a.contains('/'))
            .map(|x| x.1)
            .unwrap_or(r);
        let (h, p) = r.split_once('/')?;
        (h.split(':').next()?.to_string(), p.to_string())
    } else if s.contains('@') && s.contains(':') && !s.contains("://") {
        let r = s.split_once('@')?.1;
        let (h, p) = r.split_once(':')?;
        (h.to_string(), p.trim_start_matches('/').to_string())
    } else {
        return None;
    };
    let p = path.trim_end_matches('/');
    let p = p.strip_suffix(".git").unwrap_or(p);
    if host.is_empty() || p.is_empty() {
        return None;
    }
    Some(format!("https://{host}/{p}"))
}
fn git_info(path: &Path) -> Result<RepoInfo, String> {
    let r = Repository::open(path).map_err(err)?;
    let head = r.head().ok();
    let detached = r.head_detached().unwrap_or(false);
    let branch = match &head {
        Some(h) => if detached {
            format!(
                "detached@{}",
                h
                    .target()
                    .map(|o| o.to_string().chars().take(7).collect::<String>())
                    .unwrap_or_default()
            )
        } else {
            h.shorthand().ok().unwrap_or("HEAD").to_string()
        }
        None =>
            std::fs
                ::read_to_string(r.path().join("HEAD"))
                .ok()
                .and_then(|s| s.trim().strip_prefix("ref: refs/heads/").map(str::to_string))
                .unwrap_or_else(|| "unknown".into()),
    };
    let remote = r
        .find_remote("origin")
        .ok()
        .and_then(|x| x.url().ok().map(str::to_string))
        .or_else(|| {
            let names = r.remotes().ok()?;
            let n = names.iter().flatten().flatten().next()?.to_string();
            r.find_remote(&n).ok()?.url().ok().map(str::to_string)
        });
    let remote_web = remote.as_deref().and_then(web_url);
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    if
        let (Some(h), Ok(b)) = (
            head.as_ref().and_then(|h| h.target()),
            r.find_branch(&branch, BranchType::Local),
        )
    {
        if let Ok(up) = b.upstream() {
            upstream = up.name().ok().flatten().map(str::to_string);
            if let Some(u) = up.get().target() {
                if let Ok((a, bh)) = r.graph_ahead_behind(h, u) {
                    ahead = a;
                    behind = bh;
                }
            }
        }
    }
    let last_commit = head
        .and_then(|h| h.target())
        .and_then(|id| r.find_commit(id).ok())
        .map(|c| c.time().seconds());
    let mut s = StatusOptions::new();
    s.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = r.statuses(Some(&mut s)).map_err(err)?;
    let mut modified = Vec::new();
    let mut staged = Vec::new();
    let mut untracked = Vec::new();
    let mut deleted = Vec::new();
    let mut conflicted = Vec::new();
    for x in statuses.iter() {
        let st = x.status();
        let p = x.path().unwrap_or("").to_string();
        if st.is_conflicted() {
            conflicted.push(p.clone());
        }
        if st.is_wt_modified() {
            modified.push(p.clone());
        }
        if
            st.is_index_new() ||
            st.is_index_modified() ||
            st.is_index_deleted() ||
            st.is_index_renamed() ||
            st.is_index_typechange()
        {
            staged.push(p.clone());
        }
        if st.is_wt_new() {
            untracked.push(p.clone());
        }
        if st.is_wt_deleted() || st.is_index_deleted() {
            deleted.push(p);
        }
    }
    for v in [&mut modified, &mut staged, &mut untracked, &mut deleted, &mut conflicted] {
        v.sort();
        v.dedup();
    }
    Ok(RepoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or("repository")
            .to_string(),
        branch,
        remote,
        remote_web,
        upstream,
        ahead,
        behind,
        last_commit,
        dirty: !(
            modified.is_empty() &&
            staged.is_empty() &&
            untracked.is_empty() &&
            deleted.is_empty() &&
            conflicted.is_empty()
        ),
        unpushed: ahead > 0,
        modified,
        staged,
        untracked,
        deleted,
        conflicted,
    })
}
fn info_of(c: &git2::Commit) -> CommitInfo {
    let a = c.author();
    let m = c.committer();
    let id = c.id().to_string();
    CommitInfo {
        short_id: id.chars().take(7).collect(),
        id,
        author: a.name().unwrap_or("Unknown").into(),
        email: a.email().unwrap_or("").into(),
        date: a.when().seconds(),
        committer: m.name().unwrap_or("Unknown").into(),
        committer_email: m.email().unwrap_or("").into(),
        committer_date: m.when().seconds(),
        message: c.message().unwrap_or("").into(),
        parents: c
            .parent_ids()
            .map(|p| p.to_string())
            .collect(),
    }
}
fn commit_page(path: &Path, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let r = Repository::open(path).map_err(err)?;
    let mut w = r.revwalk().map_err(err)?;
    if w.push_head().is_err() {
        return Ok(vec![]);
    }
    w.set_sorting(git2::Sort::TIME).map_err(err)?;
    let mut out = Vec::new();
    for id in w.flatten().skip(skip).take(limit) {
        let c = r.find_commit(id).map_err(err)?;
        out.push(info_of(&c));
    }
    Ok(out)
}
fn commit_diff(path: &Path, id: &str) -> Result<CommitDetail, String> {
    let r = Repository::open(path).map_err(err)?;
    let c = r.find_commit(Oid::from_str(id).map_err(err)?).map_err(err)?;
    let tree = c.tree().map_err(err)?;
    let parent = if c.parent_count() > 0 {
        Some(c.parent(0).map_err(err)?.tree().map_err(err)?)
    } else {
        None
    };
    let mut o = DiffOptions::new();
    o.context_lines(3);
    let mut d = r.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut o)).map_err(err)?;
    let mut fo = DiffFindOptions::new();
    fo.renames(true);
    let _ = d.find_similar(Some(&mut fo));
    let st = d.stats().map_err(err)?;
    let mut files = Vec::new();
    for i in 0..d.deltas().len() {
        let delta = d.get_delta(i).ok_or("missing delta")?;
        let status = match delta.status() {
            Delta::Added => "added",
            Delta::Deleted => "deleted",
            Delta::Renamed => "renamed",
            Delta::Copied => "copied",
            Delta::Typechange => "typechange",
            _ => "modified",
        };
        let np = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let op = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let path = np.clone().or(op.clone()).unwrap_or_default();
        let old_path = if status == "renamed" || status == "copied" { op } else { None };
        let (mut ins, mut del, mut patch, mut binary, mut truncated) = (
            0,
            0,
            String::new(),
            delta.flags().is_binary(),
            false,
        );
        if i >= 300 {
            truncated = true;
        } else if let Ok(Some(mut p)) = Patch::from_diff(&d, i) {
            binary = binary || p.delta().flags().is_binary();
            if !binary {
                if let Ok((_, a, b)) = p.line_stats() {
                    ins = a;
                    del = b;
                }
                if let Ok(buf) = p.to_buf() {
                    let t = String::from_utf8_lossy(&buf).into_owned();
                    if t.len() > 200_000 {
                        truncated = true;
                        patch = t.chars().take(200_000).collect();
                    } else {
                        patch = t;
                    }
                }
            }
        }
        files.push(FileChange {
            path,
            old_path,
            status: status.into(),
            insertions: ins,
            deletions: del,
            binary,
            truncated,
            patch,
        });
    }
    Ok(CommitDetail {
        info: info_of(&c),
        insertions: st.insertions(),
        deletions: st.deletions(),
        files,
    })
}
fn drives() -> Vec<String> {
    iso_roots()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}
fn make_watcher(
    known: Arc<Mutex<HashSet<PathBuf>>>,
    tx: mpsc::Sender<Ev>,
    targets: &[PathBuf]
) -> Option<RecommendedWatcher> {
    let tg: Vec<PathBuf> = targets.to_vec();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(e) = res else {
                return;
            };
            if matches!(e.kind, EventKind::Access(_)) {
                return;
            }
            let nameev = matches!(e.kind, EventKind::Modify(notify::event::ModifyKind::Name(_)));
            let k = known.lock().unwrap();
            for p in &e.paths {
                if let Some(a) = p.ancestors().find(|a| k.contains(*a)) {
                if p.strip_prefix(a).map_or(false, skip) {
                    continue;
                }
                let _ = tx.send(Ev::Repo(a.to_path_buf()));
                continue;
            }
            if skip(tg.iter().find_map(|t| p.strip_prefix(t).ok()).unwrap_or(p)) {
                continue;
            }
                if e.kind.is_create() || nameev {
                    if p.file_name().map_or(false, |n| n == ".git") {
                        if let Some(d) = p.parent() {
                            let _ = tx.send(Ev::New(d.to_path_buf()));
                        }
                    } else if p.join(".git").exists() {
                        let _ = tx.send(Ev::New(p.to_path_buf()));
                    }
                }
            }
        })
        .ok()?;
    for t in targets {
        let _ = w.watch(t, RecursiveMode::Recursive);
    }
    Some(w)
}
fn apply(st: &Store, ev: Ev) -> Option<Out> {
    match ev {
        Ev::Repo(p) => {
            if !drive_ok(&p) {
                return None;
            }
            if !p.join(".git").exists() {
                st.remove(&p);
                return Some(Out::Rem(p.to_string_lossy().into_owned()));
            }
            let i = git_info(&p).ok()?;
            if st.upsert(&i) {
                Some(Out::Upd(i))
            } else {
                None
            }
        }
        Ev::New(p) => {
            if st.known.lock().unwrap().contains(&p) {
                return None;
            }
            let mut i = git_info(&p);
            if i.is_err() {
                thread::sleep(Duration::from_millis(800));
                i = git_info(&p);
            }
            let i = i.ok()?;
            st.upsert(&i);
            Some(Out::Add(i))
        }
    }
}
fn spawn_worker(st: Store, rx: mpsc::Receiver<Ev>, emit: impl Fn(Out) + Send + 'static) {
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut set = HashSet::new();
            set.insert(first);
            let until = std::time::Instant::now() + Duration::from_millis(400);
            while
                let Ok(ev) = rx.recv_timeout(
                    until.saturating_duration_since(std::time::Instant::now())
                )
            {
                set.insert(ev);
            }
            let mut dirty = false;
            for ev in set {
                if let Some(o) = apply(&st, ev) {
                    emit(o);
                    dirty = true;
                }
            }
            if dirty {
                st.save();
            }
        }
    });
}
fn start_live(app: &AppHandle, st: &Store, roots: &[String]) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel();
    let targets: Vec<PathBuf> = if cfg!(any(target_os = "windows", target_os = "macos")) {
        roots.iter().map(PathBuf::from).collect()
    } else {
        st.known.lock().unwrap().iter().cloned().collect()
    };
    let w = make_watcher(st.known.clone(), tx, &targets)?;
    let a = app.clone();
    spawn_worker(st.clone(), rx, move |o| {
        match o {
            Out::Upd(i) => {
                let _ = a.emit("repo-updated", i);
            }
            Out::Add(i) => {
                let _ = a.emit("repo-added", i);
            }
            Out::Rem(p) => {
                let _ = a.emit("repo-removed", p);
            }
        }
    });
    Some(w)
}
#[tauri::command]
fn get_ignore() -> Vec<String> {
    extra().lock().unwrap().clone()
}
#[tauri::command]
fn set_ignore(list: Vec<String>, st: State<Store>) {
    let mut v: Vec<String> = list
        .iter()
        .map(|x| x.trim().to_ascii_lowercase())
        .filter(|x| !x.is_empty())
        .collect();
    v.sort();
    v.dedup();
    *extra().lock().unwrap() = v;
    st.save();
}
#[tauri::command]
fn startup(app: AppHandle, st: State<Store>) -> Startup {
    let (roots, last_scan) = st.meta.lock().unwrap().clone();
    let a = app.clone();
    thread::spawn(move || {
        let st = a.state::<Store>();
        let live = a.state::<WatchState>();
        let r = st.meta.lock().unwrap().0.clone();
        let w = if r.is_empty() { drives() } else { r };
        *live.watcher.lock().unwrap() = start_live(&a, &st, &w);
    });
    Startup { repos: st.all(), roots, drives: vec![], last_scan }
}
#[tauri::command]
async fn drives_info(st: State<'_, Store>) -> Result<DriveInfo, String> {
    let st = st.inner().clone();
    tauri::async_runtime
        ::spawn_blocking(move || {
            let d = drives();
            let r = st.meta.lock().unwrap().0.clone();
            DriveInfo { drives: d.clone(), roots: if r.is_empty() { d } else { r } }
        }).await
        .map_err(err)
}
#[tauri::command]
async fn refresh_all(app: AppHandle, st: State<'_, Store>) -> Result<(), String> {
    let st = st.inner().clone();
    tauri::async_runtime
        ::spawn_blocking(move || {
            let list: Vec<PathBuf> = st.known.lock().unwrap().iter().cloned().collect();
            let mut dirty = false;
            for p in list {
                if !drive_ok(&p) {
                    continue;
                }
                if !p.join(".git").exists() {
                    st.remove(&p);
                    let _ = app.emit("repo-removed", p.to_string_lossy().into_owned());
                    dirty = true;
                    continue;
                }
                if let Ok(i) = git_info(&p) {
                    if st.upsert(&i) {
                        let _ = app.emit("repo-updated", i);
                        dirty = true;
                    }
                }
            }
            if dirty {
                st.save()
            }
        }).await
        .map_err(err)
}
#[tauri::command]
async fn scan(
    paths: Vec<String>,
    background: bool,
    app: AppHandle,
    state: State<'_, ScanState>,
    store: State<'_, Store>,
    live: State<'_, WatchState>
) -> Result<Vec<RepoInfo>, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".into());
    }
    let running = state.running.clone();
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let st = store.inner().clone();
    let roots = if paths.is_empty() { drives() } else { paths };
    let (r2, a2, st2) = (roots.clone(), app.clone(), st.clone());
    let res = tauri::async_runtime::spawn_blocking(move || {
        let app = a2;
        let dirs = Arc::new(AtomicUsize::new(0));
        let found = Arc::new(Mutex::new(Vec::new()));
        for root in r2.iter().map(PathBuf::from) {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if root.exists() {
                prog(
                    &app,
                    &format!("Scanning {}", root.display()),
                    &root.to_string_lossy(),
                    dirs.load(Ordering::Relaxed),
                    found.lock().unwrap().len(),
                    0,
                    0
                );
                scan_one(&root, background, &app, &cancel, &dirs, &found);
            }
        }
        let set: HashSet<PathBuf> = found.lock().unwrap().iter().cloned().collect();
        let mut list: Vec<PathBuf> = set.into_iter().collect();
        list.sort();
        let total = list.len();
        let nd = dirs.load(Ordering::Relaxed);
        let mut repos = Vec::new();
        for (i, p) in list.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            prog(&app, "Inspecting repositories", &p.to_string_lossy(), nd, total, i, total);
            if let Ok(r) = git_info(p) {
                repos.push(r);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            for r in &repos {
                st2.upsert(r);
            }
        } else {
            st2.replace(&repos, &r2);
        }
        st2.save();
        prog(&app, "Done", "", nd, repos.len(), total, total);
    }).await;
    running.store(false, Ordering::SeqCst);
    res.map_err(err)?;
    *live.watcher.lock().unwrap() = start_live(&app, &st, &roots);
    Ok(st.all())
}
#[tauri::command]
fn cancel_scan(state: State<ScanState>) {
    state.cancel.store(true, Ordering::Relaxed);
}
#[tauri::command]
async fn repo_info(path: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git_info(Path::new(&path))).await.map_err(err)?
}
#[tauri::command]
async fn commit_list(path: String, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    tauri::async_runtime
        ::spawn_blocking(move || commit_page(Path::new(&path), skip, limit)).await
        .map_err(err)?
}
#[tauri::command]
async fn commit_detail(path: String, id: String) -> Result<CommitDetail, String> {
    tauri::async_runtime
        ::spawn_blocking(move || commit_diff(Path::new(&path), &id)).await
        .map_err(err)?
}
#[cfg(not(target_os = "windows"))]
fn launch(program: &str, args: &[&str], dir: &Path) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .current_dir(dir)
        .spawn()
        .map(|_| ())
        .map_err(err)
}
#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", "cmd"])
            .current_dir(&p)
            .spawn()
            .map(|_| ())
            .map_err(err)
    }
    #[cfg(target_os = "macos")]
    {
        launch("open", &["-a", "Terminal", "."], &p)
    }
    #[cfg(target_os = "linux")]
    {
        launch("x-terminal-emulator", &[], &p)
            .or_else(|_| launch("gnome-terminal", &[], &p))
            .or_else(|_| launch("konsole", &[], &p))
            .or_else(|_| launch("xterm", &[], &p))
    }
}
#[tauri::command]
fn open_remote(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only HTTP(S) URLs are allowed".into());
    }
    open::that(url).map_err(err)
}

fn main() {
    tauri::Builder
        ::default()
        .plugin(
            tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            })
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Store::load(dir.join("cache.json")));
            Ok(())
        })
        .manage(ScanState {
            cancel: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
        })
        .manage(WatchState { watcher: Mutex::new(None) })
        .invoke_handler(
            tauri::generate_handler![
                startup,
                get_ignore,
                set_ignore,
                drives_info,
                scan,
                cancel_scan,
                refresh_all,
                repo_info,
                commit_list,
                commit_detail,
                open_terminal,
                open_remote
            ]
        )
        .run(tauri::generate_context!())
        .expect("error while running GitPulse");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as C;
    fn g(d: &Path, a: &[&str]) {
        assert!(C::new("git").args(a).current_dir(d).output().unwrap().status.success())
    }
    fn mk(d: &Path) {
        std::fs::create_dir_all(d).unwrap();
        g(d, &["init", "-q", "-b", "main"]);
        g(d, &["config", "user.email", "a@b.c"]);
        g(d, &["config", "user.name", "A"]);
        std::fs::write(d.join("f"), "1").unwrap();
        g(d, &["add", "."]);
        g(d, &["commit", "-qm", "i"])
    }
    #[test]
    fn urls() {
        assert_eq!(web_url("git@github.com:u/r.git").as_deref(), Some("https://github.com/u/r"));
        assert_eq!(
            web_url("https://user:tok@github.com/u/r.git/").as_deref(),
            Some("https://github.com/u/r")
        );
        assert!(web_url("C:\\repos\\x").is_none())
    }
    #[test]
    fn diff() {
        let d = std::env::temp_dir().join("gp_diff");
        let _ = std::fs::remove_dir_all(&d);
        mk(&d);
        std::fs::write(d.join("old.txt"), "keep\nkeep2\nkeep3\nkeep4\n").unwrap();
        std::fs::write(d.join("gone.txt"), "x\n").unwrap();
        g(&d, &["add", "."]);
        g(&d, &["commit", "-qm", "two"]);
        std::fs::write(d.join("b.txt"), "new\n").unwrap();
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        g(&d, &["mv", "old.txt", "new.txt"]);
        g(&d, &["add", "-A"]);
        g(&d, &["commit", "-qm", "three\n\nbody"]);
        let l = commit_page(&d, 0, 50).unwrap();
        assert_eq!(l.len(), 3);
        let x = commit_diff(&d, &l[0].id).unwrap();
        assert_eq!(x.files.len(), 3);
        assert!(
            x.files.iter().any(|f| f.status == "renamed") &&
                x.files.iter().any(|f| f.status == "deleted") &&
                x.files.iter().any(|f| f.status == "added" && f.patch.contains("+new"))
        );
        let e = std::env::temp_dir().join("gp_empty");
        let _ = std::fs::remove_dir_all(&e);
        std::fs::create_dir_all(&e).unwrap();
        g(&e, &["init", "-q", "-b", "dev"]);
        let j = git_info(&e).unwrap();
        assert_eq!(j.branch, "dev");
        assert!(j.last_commit.is_none());
        assert!(commit_page(&e, 0, 5).unwrap().is_empty());
    }
    #[test]
    fn live_in_ignored_parent() {
        let root = std::env::temp_dir().join("gp_live2");
        let _ = std::fs::remove_dir_all(&root);
        let a = root.join("target").join("venv").join("r");
        mk(&a);
        let st = Store::load(root.join("c.json"));
        st.replace(&[git_info(&a).unwrap()], &[root.to_string_lossy().into_owned()]);
        let (tx, rx) = mpsc::channel();
        let (otx, orx) = mpsc::channel();
        let _w = make_watcher(st.known.clone(), tx, &[root.clone()]).unwrap();
        spawn_worker(st.clone(), rx, move |o| {
            if let Out::Upd(i) = o {
                let _ = otx.send(i.name);
            }
        });
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(a.join("n.txt"), "x").unwrap();
        assert_eq!(orx.recv_timeout(Duration::from_secs(5)).unwrap(), "r");
    }
    #[test]
    fn concurrent_saves() {
        let root = std::env::temp_dir().join("gp_save");
        let _ = std::fs::remove_dir_all(&root);
        let a = root.join("a");
        mk(&a);
        let st = Store::load(root.join("cache.json"));
        st.replace(&[git_info(&a).unwrap()], &[root.to_string_lossy().into_owned()]);
        let hs: Vec<_> = (0..8)
            .map(|_| {
                let s = st.clone();
                std::thread::spawn(move || {
                    for _ in 0..40 {
                        s.save();
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(Store::load(root.join("cache.json")).all().len(), 1);
    }
    #[test]
    fn live() {
        let root = std::env::temp_dir().join("gp_live");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a");
        mk(&a);
        let cf = root.join("cache.json");
        let st = Store::load(cf.clone());
        st.replace(&[git_info(&a).unwrap()], &[root.to_string_lossy().into_owned()]);
        st.save();
        let st2 = Store::load(cf.clone());
        assert_eq!(st2.all().len(), 1);
        let (tx, rx) = mpsc::channel();
        let (otx, orx) = mpsc::channel();
        let _w = make_watcher(st2.known.clone(), tx, &[root.clone()]).unwrap();
        spawn_worker(st2.clone(), rx, move |o| {
            let _ = otx.send(match o {
                Out::Upd(i) => format!("upd {}", i.name),
                Out::Add(i) => format!("add {}", i.name),
                Out::Rem(p) =>
                    format!("rem {}", Path::new(&p).file_name().unwrap().to_string_lossy()),
            });
        });
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(a.join("n.txt"), "x").unwrap();
        assert_eq!(orx.recv_timeout(Duration::from_secs(5)).unwrap(), "upd a");
        let b = root.join("b");
        mk(&b);
        let mut ok = false;
        while let Ok(m) = orx.recv_timeout(Duration::from_secs(4)) {
            if m == "add b" {
                ok = true;
                break;
            }
        }
        assert!(ok);
        std::fs::remove_dir_all(&b).unwrap();
        let mut rem = false;
        while let Ok(m) = orx.recv_timeout(Duration::from_secs(4)) {
            if m == "rem b" {
                rem = true;
                break;
            }
        }
        assert!(rem);
    }
}
