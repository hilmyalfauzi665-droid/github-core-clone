// The forge's in-memory store: repositories, git objects, refs, issues, pull
// requests, labels and comments. One process, no persistence: the suite drives
// everything through the API in one trial, so memory is the store.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type TreeEntry,
} from './gitobj.ts';

/** The login the bearer token names (wire.ts's seeded viewer, fixed by the seed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The identity every server-made commit carries. */
export const COMMIT_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
/** A fixed commit timestamp (the scenario epoch): two runs make the same bytes. */
export const COMMIT_TIMESTAMP = 1735689600;
/** The merged_at every squash merge reports (fixed, deterministic). */
export const MERGED_AT = '2025-01-01T00:00:00.000Z';
/** The default branch a new repository is born with. */
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  commitSeq: Map<string, number>;
  nextCommitSeq: number;
  commitMeta: Map<string, { message: string }>;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return globalId('Repository', `${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return globalId('Issue', `${owner}/${name}#${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return globalId('PullRequest', `${owner}/${name}#${number}`);
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', `${owner}/${name}#${issueNumber}#${commentId}`);
}

function linesOf(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** A multiset line diff: lines added and lines removed between two texts. */
function lineDiff(oldText: string, newText: string): [number, number] {
  const oldCount = new Map<string, number>();
  const newCount = new Map<string, number>();
  for (const line of linesOf(oldText)) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  for (const line of linesOf(newText)) newCount.set(line, (newCount.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCount) additions += Math.max(0, count - (oldCount.get(line) ?? 0));
  for (const [line, count] of oldCount) deletions += Math.max(0, count - (newCount.get(line) ?? 0));
  return [additions, deletions];
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  private repoCreatedSeq = 0;

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoCreatedSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      commitSeq: new Map(),
      nextCommitSeq: 0,
      commitMeta: new Map(),
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') repo.commitSeq.set(oid, repo.nextCommitSeq++);
    }
    return oid;
  }

  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store a commit object built by the server; records the display message. */
  createCommit(repo: Repo, opts: { tree: string; parents?: readonly string[]; message: string }): string {
    const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
    const data = buildCommit({
      tree: opts.tree,
      parents: opts.parents ?? [],
      message,
      author: COMMIT_IDENTITY,
      committer: COMMIT_IDENTITY,
      timestamp: COMMIT_TIMESTAMP,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.commitMeta.set(oid, { message: opts.message });
    return oid;
  }

  /** The commit message as the API should show it (exactly what was submitted). */
  commitMessageOf(repo: Repo, oid: string): string {
    const meta = repo.commitMeta.get(oid);
    if (meta) return meta.message;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return '';
    const message = parseCommit(object.data).message;
    return message.endsWith('\n') ? message.slice(0, -1) : message;
  }

  commitTimestampOf(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return 0;
    const author = parseCommit(object.data).author;
    const match = / (\d+) [+-]\d{4}$/.exec(author);
    return match ? Number(match[1]) : 0;
  }

  /** Commits reachable from `tip`, newest first (timestamp, then insertion order). */
  commitsReachable(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    out.sort((a, b) => {
      const ta = this.commitTimestampOf(repo, a);
      const tb = this.commitTimestampOf(repo, b);
      if (ta !== tb) return tb - ta;
      return (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0);
    });
    return out;
  }

  /** Flatten a tree to path -> {oid, mode}, recursing into directories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested tree objects from a flat path map; returns the root tree oid. */
  treeFromFileMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index]!;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Apply one file change to a tree: set `path` to `blobOid` (or delete it when null)
   * and return the new root tree oid.
   */
  applyFileToTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const files = treeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, treeOid);
    if (blobOid === null) files.delete(path);
    else files.set(path, { oid: blobOid, mode: '100644' });
    return this.treeFromFileMap(repo, files);
  }

  /** The blob oid at `path` in the tree `treeOid`, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
    return this.flattenTree(repo, treeOid).get(path)?.oid ?? null;
  }

  /** The 3-way file diff between two trees (base -> head). */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): DiffFile[] {
    const base = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, headTreeOid);
    const blobText = (oid: string): string => {
      const object = repo.objects.get(oid);
      return object && object.type === 'blob' ? object.data.toString('utf8') : '';
    };
    const files: DiffFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const deletions = linesOf(blobText(b.oid)).length;
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const additions = linesOf(blobText(h.oid)).length;
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const [additions, deletions] = lineDiff(blobText(b.oid), blobText(h.oid));
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests: mergeability and squash merge
  // -------------------------------------------------------------------------------------------

  /** Whether a pull request would conflict, without changing anything. */
  prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    return this.mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The conflicting path of a 3-way merge, or null when it merges cleanly. Both sides
   * changed the same path relative to the merge base and ended with different bytes.
   */
  mergeConflict(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return 'missing-branch';
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    if (base === null) return 'no-merge-base';
    const baseObject = repo.objects.get(base);
    const headObject = repo.objects.get(headTip);
    const baseTipObject = repo.objects.get(baseTip);
    if (!baseObject || !headObject || !baseTipObject) return 'missing-object';
    const baseTree = parseCommit(baseObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const baseTipTree = parseCommit(baseTipObject.data).tree;
    const headChanges = new Map(this.diffTrees(repo, baseTree, headTree).map((file) => [file.filename, file]));
    const baseChanges = new Map(this.diffTrees(repo, baseTree, baseTipTree).map((file) => [file.filename, file]));
    const headFlat = this.flattenTree(repo, headTree);
    const baseTipFlat = this.flattenTree(repo, baseTipTree);
    for (const path of headChanges.keys()) {
      if (!baseChanges.has(path)) continue;
      const h = headFlat.get(path);
      const m = baseTipFlat.get(path);
      if (h === undefined && m === undefined) continue; // both deleted it
      if (h === undefined || m === undefined) return path; // delete against modify
      if (h.oid !== m.oid) return path;
    }
    return null;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit on the base branch
   * whose tree is the base tip's tree with the head's changes applied. Returns the
   * merge commit sha, or null with a reason when it cannot merge.
   */
  mergePullRequest(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'pull request is not open' };
    const conflict = this.mergeConflict(repo, pull);
    if (conflict !== null) return { ok: false, reason: `merge conflict in ${conflict}` };
    const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    const base = mergeBase(headTip, baseTip, this.lookup(repo))!;
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const headFlat = this.flattenTree(repo, headTree);
    const files = this.flattenTree(repo, baseTipTree);
    for (const change of headChanges) {
      if (change.status === 'removed') files.delete(change.filename);
      else {
        const entry = headFlat.get(change.filename);
        if (entry) files.set(change.filename, entry);
      }
    }
    const tree = this.treeFromFileMap(repo, files);
    const sha = this.createCommit(repo, { tree, parents: [baseTip], message: pull.title });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = MERGED_AT;
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    return { ok: true, sha };
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  nextIssueNumber(repo: Repo): number {
    return repo.nextNumber++;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: this.nextIssueNumber(repo),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.issues.length + repo.pulls.length,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string; headSha: string; baseSha: string }): Pull {
    const pull: Pull = {
      id: this.nextIssueId++,
      number: this.nextIssueNumber(repo),
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      headSha: input.headSha,
      baseSha: input.baseSha,
      seq: repo.issues.length + repo.pulls.length,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  // -------------------------------------------------------------------------------------------
  // shared git helpers
  // -------------------------------------------------------------------------------------------

  /** True when `old` is an ancestor of (or equal to) `tip` in this repo. */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === newOid) return true;
    return isAncestor(oldOid, newOid, this.lookup(repo));
  }

  /** Every object reachable from the repo's refs (used by the git harness's accounting). */
  reachableFromRefs(repo: Repo): Set<string> {
    const tips = [...repo.refs.values()].filter((oid) => isObjectId(oid));
    return collectReachable(tips, this.lookup(repo), { allowMissing: true });
  }

  /** Peel a ref's target to its commit, or null. */
  peelRef(repo: Repo, oid: string): string | null {
    return peelToCommit(oid, this.lookup(repo));
  }
}
