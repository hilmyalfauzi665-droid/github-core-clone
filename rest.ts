// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Every reply is JSON with a message on errors,
// a non-empty X-GitHub-Request-Id (added by app.ts), and Link pagination.

import { isObjectId, mergeBase, parseCommit, parseTree } from './gitobj.ts';
import {
  isAuthenticated,
  jsonError,
  jsonResponse,
  parseJsonBody,
  type HttpRequest,
  type HttpResponse,
} from './http.ts';
import {
  VIEWER,
  Store,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

const FIXED_DATE = '2025-01-01T00:00:00Z';
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------------------------
// views (serializers)
// ---------------------------------------------------------------------------------------------

function userView(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', avatar_url: '', html_url: '' };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    has_issues: true,
    has_pull_requests: true,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: null };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(label) : { name, color: 'ededed', description: null };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function commitView(store: Store, repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const message = object ? store.commitMessageOf(repo, sha) : '';
  const timestamp = object ? store.commitTimestampOf(repo, sha) : 0;
  const date = timestamp > 0 ? new Date(timestamp * 1000).toISOString() : FIXED_DATE;
  return {
    sha,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email, date },
      committer: { name: VIEWER.name, email: VIEWER.email, date },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

function boolField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

function intQuery(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Paginate a list; returns the page and the Link header value (or null). */
function paginate<T>(
  items: readonly T[],
  req: HttpRequest,
  path: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intQuery(req.query, 'per_page', 30)));
  const page = Math.max(1, intQuery(req.query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: [...slice], link: null };
  const base = `${req.origin}${path}`;
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${base}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return { page: [...slice], link: links.join(', ') };
}

function pagedJson<T>(items: readonly T[], req: HttpRequest, path: string, view: (item: T) => unknown): HttpResponse {
  const { page, link } = paginate(items, req, path);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return jsonResponse(200, page.map(view), headers);
}

/** Read a JSON body; 400 when the body is present but not JSON, or not an object. */
function readBodyObject(req: HttpRequest): { body: Record<string, unknown> | null; error: HttpResponse | null } {
  const { value, error } = parseJsonBody(req.body);
  if (error) return { body: null, error: jsonError(400, 'Invalid JSON body') };
  if (value === undefined) return { body: {}, error: null };
  if (!isRecord(value)) return { body: null, error: jsonError(400, 'Request body must be a JSON object') };
  return { body: value, error: null };
}

/** Resolve a repo from the URL owner/name; 404 unless the token's owner owns it. */
function resolveRepo(store: Store, owner: string, name: string): { repo: Repo | null; error: HttpResponse | null } {
  if (owner !== VIEWER.login) return { repo: null, error: jsonError(404, 'Not Found') };
  const repo = store.getRepo(owner, name) ?? null;
  if (!repo) return { repo: null, error: jsonError(404, 'Not Found') };
  return { repo, error: null };
}

/** Resolve a ref (branch name, full ref, or commit sha) to a tip commit oid. */
function resolveRefTip(repo: Repo, ref: string): string | null {
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsPathOf(segments: string[]): string {
  return segments.join('/');
}

function fileView(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const blob = repo.objects.get(blobOid);
  const content = blob && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name: path.split('/').pop() ?? path,
    path,
    content: content.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: '',
  };
}

function dirView(repo: Repo, dirPath: string, treeOid: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return entries;
  for (const entry of parseTree(object.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    entries.push({
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: '',
    });
  }
  return entries;
}

/** Walk a tree to `path`; returns the object oid and whether it is a directory. */
function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; isDir: boolean } | null {
  if (path === '') return { oid: treeOid, isDir: true };
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, isDir: entry.mode === '40000' };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function putContents(store: Store, repo: Repo, filePath: string, req: HttpRequest): HttpResponse {
  const { body, error } = readBodyObject(req);
  if (error) return error;
  const message = stringField(body!, 'message');
  const contentB64 = stringField(body!, 'content');
  if (contentB64 === null) return jsonError(400, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return jsonError(400, 'content is not valid base64');
  }
  const branch = stringField(body!, 'branch') ?? repo.defaultBranch;
  const sha = stringField(body!, 'sha');
  const blobOid = store.putObject(repo, 'blob', content);
  let branchTip = repo.refs.get(`refs/heads/${branch}`);
  let parentTree: string | null = null;
  let isUpdate = false;
  if (branchTip !== undefined) {
    const commitObject = repo.objects.get(branchTip);
    if (!commitObject) return jsonError(404, 'Not Found');
    parentTree = parseCommit(commitObject.data).tree;
    const existing = store.blobAtPath(repo, parentTree, filePath);
    if (existing !== null) {
      isUpdate = true;
      if (sha === null) return jsonError(409, 'sha is required to update an existing file');
      if (sha.toLowerCase() !== existing.toLowerCase()) return jsonError(409, 'sha does not match the current file');
    }
  } else if (repo.refs.size === 0) {
    // An unborn repository accepts its first commit on any branch; that branch
    // becomes the default branch.
    parentTree = null;
  } else {
    // Create the branch from the default tip, then commit on it.
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip === undefined) return jsonError(422, 'no base commit to branch from');
    const defaultObject = repo.objects.get(defaultTip);
    if (!defaultObject) return jsonError(404, 'Not Found');
    branchTip = defaultTip;
    parentTree = parseCommit(defaultObject.data).tree;
  }
  const tree = store.applyFileToTree(repo, parentTree, filePath, blobOid);
  const parents = branchTip === undefined ? [] : [branchTip];
  const commitSha = store.createCommit(repo, { tree, parents, message: message ?? `Update ${filePath}` });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  if (repo.refs.size === 1) repo.defaultBranch = branch;
  return jsonResponse(isUpdate ? 200 : 201, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobOid,
    },
    commit: { sha: commitSha },
  });
}

function getContents(store: Store, repo: Repo, filePath: string, req: HttpRequest): HttpResponse {
  const ref = req.query.get('ref');
  let tip: string | null;
  if (ref !== null) {
    tip = resolveRefTip(repo, ref);
    if (tip === null) return jsonError(404, 'Not Found');
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (tip === null) return jsonError(404, 'Not Found');
  const commitObject = repo.objects.get(tip);
  if (!commitObject || commitObject.type !== 'commit') return jsonError(404, 'Not Found');
  const tree = parseCommit(commitObject.data).tree;
  const found = lookupPath(repo, tree, filePath);
  if (!found) return jsonError(404, 'Not Found');
  if (found.isDir) return jsonResponse(200, dirView(repo, filePath, found.oid));
  return jsonResponse(200, fileView(repo, filePath, found.oid));
}

function deleteContents(store: Store, repo: Repo, filePath: string, req: HttpRequest): HttpResponse {
  const { body, error } = readBodyObject(req);
  if (error) return error;
  const message = stringField(body!, 'message');
  const sha = stringField(body!, 'sha');
  const branch = stringField(body!, 'branch') ?? repo.defaultBranch;
  const branchTip = repo.refs.get(`refs/heads/${branch}`);
  if (branchTip === undefined) return jsonError(404, 'Not Found');
  const commitObject = repo.objects.get(branchTip);
  if (!commitObject) return jsonError(404, 'Not Found');
  const tree = parseCommit(commitObject.data).tree;
  const existing = store.blobAtPath(repo, tree, filePath);
  if (existing === null) return jsonError(404, 'Not Found');
  if (sha !== null && sha.toLowerCase() !== existing.toLowerCase()) return jsonError(409, 'sha does not match the current file');
  const newTree = store.applyFileToTree(repo, tree, filePath, null);
  const commitSha = store.createCommit(repo, { tree: newTree, parents: [branchTip], message: message ?? `Delete ${filePath}` });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return jsonResponse(200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Handle a REST v3 request. Returns null when the path is not under /api/v3
 * (the caller falls through to the git/404 handling).
 */
export function handleRest(store: Store, req: HttpRequest): HttpResponse | null {
  const segments = req.pathname.split('/').filter((part) => part !== '');
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = req.method;

  // Every /api/v3 call needs the bearer token.
  if (!isAuthenticated(req)) return jsonError(401, 'Bad credentials');

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
    return jsonResponse(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
    return jsonResponse(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
    return jsonResponse(200, userView());
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const { body, error } = readBodyObject(req);
      if (error) return error;
      const name = stringField(body!, 'name');
      if (name === null || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return jsonError(422, 'Invalid repository name');
      }
      const description = stringField(body!, 'description') ?? '';
      const isPrivate = boolField(body!, 'private', false);
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      if (!repo) return jsonError(422, 'Repository already exists');
      return jsonResponse(201, repoView(repo));
    }
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER.login);
      return pagedJson(repos, req, '/api/v3/user/repos', (repo) => repoView(repo));
    }
    return jsonError(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);
    const { repo, error } = resolveRepo(store, owner, name);
    if (error) return error;
    const r = repo!;

    // /repos/{o}/{r} itself.
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoView(r));
      if (method === 'PATCH') {
        const { body, error: bodyError } = readBodyObject(req);
        if (bodyError) return bodyError;
        const description = stringField(body!, 'description');
        if (description !== null) r.description = description;
        if (typeof body!['private'] === 'boolean') r.private = body!['private'] as boolean;
        return jsonResponse(200, repoView(r));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
      return jsonError(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/branches[/{branch...}]
    if (tail[0] === 'branches') {
      if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
      const branches = [...r.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      if (tail.length === 1) {
        return jsonResponse(200, branches.map((branch) => ({ name: branch, commit: { sha: r.refs.get(`refs/heads/${branch}`)! }, protected: false })));
      }
      const branch = tail.slice(1).join('/');
      const tip = r.refs.get(`refs/heads/${branch}`);
      if (!tip) return jsonError(404, 'Not Found');
      return jsonResponse(200, { name: branch, commit: { sha: tip }, protected: false });
    }

    // /repos/{o}/{r}/commits[/{sha}]
    if (tail[0] === 'commits') {
      if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
      if (tail.length === 2) {
        const sha = tail[1]!;
        const tip = resolveRefTip(r, sha);
        if (tip === null || !r.objects.has(tip)) return jsonError(404, 'Not Found');
        return jsonResponse(200, commitView(store, r, tip));
      }
      const ref = req.query.get('sha') ?? r.defaultBranch;
      const tip = resolveRefTip(r, ref);
      if (tip === null) return jsonError(404, 'Not Found');
      const commits = store.commitsReachable(r, tip);
      return pagedJson(commits, req, `/api/v3/repos/${owner}/${name}/commits`, (sha) => commitView(store, r, sha));
    }

    // /repos/{o}/{r}/git/refs[/...]
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const { body, error: bodyError } = readBodyObject(req);
        if (bodyError) return bodyError;
        const ref = stringField(body!, 'ref');
        const sha = stringField(body!, 'sha');
        if (ref === null || !ref.startsWith('refs/')) return jsonError(422, 'Invalid ref');
        if (sha === null || !isObjectId(sha) || !r.objects.has(sha)) return jsonError(422, 'Invalid sha');
        if (r.refs.has(ref)) return jsonError(422, 'Reference already exists');
        r.refs.set(ref, sha);
        const type = r.objects.get(sha)!.type;
        return jsonResponse(201, { ref, object: { sha, type } });
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = [...r.refs.keys()].sort().map((ref) => ({ ref, object: { sha: r.refs.get(ref)!, type: r.objects.get(r.refs.get(ref)!)?.type ?? 'commit' } }));
          return jsonResponse(200, all);
        }
        const ref = `refs/${tail.slice(2).join('/')}`;
        const tip = r.refs.get(ref);
        if (!tip) return jsonError(404, 'Not Found');
        return jsonResponse(200, { ref, object: { sha: tip, type: r.objects.get(tip)?.type ?? 'commit' } });
      }
      return jsonError(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = contentsPathOf(tail.slice(1));
      if (method === 'PUT') return putContents(store, r, filePath, req);
      if (method === 'GET') return getContents(store, r, filePath, req);
      if (method === 'DELETE') return deleteContents(store, r, filePath, req);
      return jsonError(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const { body, error: bodyError } = readBodyObject(req);
        if (bodyError) return bodyError;
        const name = stringField(body!, 'name');
        if (name === null || name === '') return jsonError(422, 'Label name is required');
        const color = stringField(body!, 'color') ?? 'ededed';
        const existing = r.labels.get(name);
        if (existing) return jsonResponse(201, labelView(existing));
        const label: Label = { name, color };
        r.labels.set(name, label);
        return jsonResponse(201, labelView(label));
      }
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, [...r.labels.values()].map(labelView));
      }
      return jsonError(405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const { body, error: bodyError } = readBodyObject(req);
          if (bodyError) return bodyError;
          const title = stringField(body!, 'title');
          if (title === null || title === '') return jsonError(422, 'Title is required');
          const issueBody = stringField(body!, 'body') ?? '';
          const labels = Array.isArray(body!['labels']) ? (body!['labels'] as unknown[]) : [];
          const labelNames: string[] = [];
          for (const label of labels) {
            if (typeof label !== 'string') return jsonError(422, 'Invalid label');
            if (!r.labels.has(label)) return jsonError(422, `Label does not exist: ${label}`);
            labelNames.push(label);
          }
          const issue = store.createIssue(r, title, issueBody, labelNames);
          return jsonResponse(201, issueView(r, issue));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let issues = [...r.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          return pagedJson(issues, req, `/api/v3/repos/${owner}/${name}/issues`, (issue) => issueView(r, issue));
        }
        return jsonError(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return jsonError(404, 'Not Found');
      const issue = store.findIssue(r, number);
      if (!issue) return jsonError(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return jsonResponse(200, issueView(r, issue));
        if (method === 'PATCH') {
          const { body, error: bodyError } = readBodyObject(req);
          if (bodyError) return bodyError;
          const state = stringField(body!, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = stringField(body!, 'title');
          if (title !== null) issue.title = title;
          const issueBody = stringField(body!, 'body');
          if (issueBody !== null) issue.body = issueBody;
          return jsonResponse(200, issueView(r, issue));
        }
        return jsonError(405, 'Method Not Allowed');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') {
          const { body, error: bodyError } = readBodyObject(req);
          if (bodyError) return bodyError;
          const commentBody = stringField(body!, 'body');
          if (commentBody === null) return jsonError(422, 'Body is required');
          const comment = { id: store.nextCommentId++, body: commentBody };
          issue.comments.push(comment);
          return jsonResponse(201, commentView(r, issue, comment));
        }
        if (method === 'GET') {
          return jsonResponse(200, issue.comments.map((comment) => commentView(r, issue, comment)));
        }
        return jsonError(405, 'Method Not Allowed');
      }
      return jsonError(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const { body, error: bodyError } = readBodyObject(req);
          if (bodyError) return bodyError;
          const title = stringField(body!, 'title');
          const head = stringField(body!, 'head');
          const base = stringField(body!, 'base') ?? r.defaultBranch;
          if (title === null || title === '') return jsonError(422, 'Title is required');
          if (head === null || head === '') return jsonError(422, 'Head is required');
          const headTip = r.refs.get(`refs/heads/${head}`);
          if (!headTip) return jsonError(422, `Head branch does not exist: ${head}`);
          const baseTip = r.refs.get(`refs/heads/${base}`);
          if (!baseTip) return jsonError(422, `Base branch does not exist: ${base}`);
          const existing = r.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
          if (existing) return jsonError(422, 'A pull request already exists for this head and base');
          const pullBody = stringField(body!, 'body') ?? '';
          const pull = store.createPull(r, { title, body: pullBody, head, base, headSha: headTip, baseSha: baseTip });
          return jsonResponse(201, pullView(r, pull));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let pulls = [...r.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.seq - a.seq);
          return pagedJson(pulls, req, `/api/v3/repos/${owner}/${name}/pulls`, (pull) => pullView(r, pull));
        }
        return jsonError(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return jsonError(404, 'Not Found');
      const pull = store.findPull(r, number);
      if (!pull) return jsonError(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return jsonResponse(200, pullView(r, pull));
        return jsonError(405, 'Method Not Allowed');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return jsonError(405, 'Method Not Allowed');
        const headTip = r.refs.get(`refs/heads/${pull.head}`);
        const baseTip = r.refs.get(`refs/heads/${pull.base}`);
        if (!headTip || !baseTip) return jsonError(404, 'Not Found');
        const base = mergeBase(headTip, baseTip, (oid) => r.objects.get(oid));
        const baseTree = base === null ? null : parseCommit(r.objects.get(base)!.data).tree;
        const headTree = parseCommit(r.objects.get(headTip)!.data).tree;
        const files = store.diffTrees(r, baseTree, headTree);
        return jsonResponse(200, files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })));
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return jsonError(405, 'Method Not Allowed');
        const result = store.mergePullRequest(r, pull);
        if (!result.ok) {
          if (result.reason.startsWith('merge conflict')) return jsonError(405, result.reason);
          return jsonError(422, result.reason);
        }
        return jsonResponse(200, { sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
      }
      return jsonError(404, 'Not Found');
    }

    return jsonError(404, 'Not Found');
  }

  // Nothing else under /api/v3 exists.
  return jsonError(404, 'Not Found');
}
