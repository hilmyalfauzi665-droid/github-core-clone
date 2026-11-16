// git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 receive-pack
// (push), and the info/refs advertisements. The wire shapes here are the ones
// the suite's git client (sdk/conformance/git-client.ts) speaks.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  splitPktLinesAndRaw,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { DEFAULT_BRANCH, Store, type Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const SIDEBAND_CHUNK = 60000;

export interface GitRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message })) };
}

/** Parse `/<owner>/<repo>.git/<rest>` into its parts, or null. */
function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repoPart = parts[1]!;
  if (!repoPart.endsWith('.git')) return null;
  const repo = repoPart.slice(0, -4);
  if (owner === '' || repo === '') return null;
  return { owner, repo, rest: parts.slice(2).join('/') };
}

/** Every ref the repo advertises, sorted by name, with peeled targets for tags. */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      // Peel the tag to its ultimate target (a commit, in this forge's use).
      let current = oid;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const obj = repo.objects.get(current);
        if (!obj || obj.type !== 'tag') break;
        current = parseTag(obj.data).object;
      }
      if (current !== oid && isObjectId(current)) entry.peeled = current;
    }
    refs.push(entry);
  }
  return refs;
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'fetch=shallow\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => encodePktLine(line)), pktLineFlush()]);
}

/** The v0 ref advertisement for a service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`
      : `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k agent=${AGENT}`;
  const chunks: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const refs = advertisedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  if (refs.length === 0) {
    chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    chunks.push(encodePktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      chunks.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) chunks.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  chunks.push(pktLineFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in deterministic order. */
  send: GitObject[];
  /** New shallow boundaries (commits at the depth limit). */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves that are ancestors of a want (for ACK lines). */
  acks: string[];
  /** Haves the client sent (a request with none skips negotiation). */
  haves: string[];
}

/**
 * Walk commits from `roots`, following parents up to `maxDepth` generations
 * (1 = the roots themselves). `stopAt` commits are included but their parents
 * are not followed (the client's shallow boundaries). Returns the commit set,
 * the boundary commits (at the depth limit), and every object the walk touches
 * (commits + their tree closures).
 */
function walkCommits(
  repo: Repo,
  roots: readonly string[],
  options: { maxDepth?: number | null; stopAt?: ReadonlySet<string> },
): { commits: Set<string>; boundary: string[]; objects: Set<string> } {
  const maxDepth = options.maxDepth ?? null;
  const stopAt = options.stopAt ?? new Set<string>();
  const commits = new Set<string>();
  const boundary: string[] = [];
  const objects = new Set<string>();
  // A commit's tree closure: its trees and blobs only, never its parents.
  const addTreeClosure = (treeOid: string): void => {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return;
    objects.add(treeOid);
    for (const entry of parseTree(treeObject.data)) {
      if (entry.mode === '40000') addTreeClosure(entry.oid);
      else objects.add(entry.oid);
    }
  };
  // Resolve tag roots to their commits, keeping the tag objects themselves.
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (!object) continue;
    if (object.type === 'tag') {
      objects.add(root);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') queue.push({ oid: target, generation: 1 });
      else if (targetObject) objects.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid: root, generation: 1 });
    } else {
      objects.add(root);
    }
  }
  while (queue.length) {
    const { oid, generation } = queue.shift()!;
    if (commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commits.add(oid);
    objects.add(oid);
    addTreeClosure(parseCommit(object.data).tree);
    const atLimit = maxDepth !== null && generation >= maxDepth;
    if (atLimit) {
      boundary.push(oid);
      continue;
    }
    if (stopAt.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  return { commits, boundary, objects };
}

/** Plan a fetch: what to send, the new shallow boundary, unshallow lines, ACKs. */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const stopAt = new Set(shallow);
  const wantWalk = walkCommits(repo, wants, { maxDepth: depth });
  const haveWalk = haves.length ? walkCommits(repo, haves, { stopAt }) : { commits: new Set<string>(), boundary: [], objects: new Set<string>() };
  const send = new Set<string>();
  for (const oid of wantWalk.objects) if (!haveWalk.objects.has(oid)) send.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const newBoundary = new Set(wantWalk.boundary);
  const unshallow: string[] = [];
  for (const old of shallow) {
    if (wantWalk.commits.has(old) && !newBoundary.has(old)) unshallow.push(old);
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (wantWalk.commits.has(have)) acks.push(have);
  }
  return { send: objects, shallow: [...wantWalk.boundary], unshallow, acks, haves: [...haves] };
}

/**
 * Frame a fetch plan as a protocol v2 response body.
 *
 * The shape depends on whether the request carried "done" (upload-pack.c's
 * rule): a request with "done" gets NO acknowledgments section at all — the
 * response goes straight to the shallow-info and packfile sections, because
 * the client skips straight to reading the packfile. A request without
 * "done" is a negotiation round: it gets only the acknowledgments section,
 * unless the client already holds everything (an empty send set), in which
 * case the server answers "ready" and the packfile follows in the same
 * response. The packfile section is always sent when the packfile is due,
 * even when it carries an empty pack — the client requires the header.
 */
function frameFetchV2(plan: FetchPlan, done: boolean): Buffer {
  const chunks: Buffer[] = [];
  // The packfile section: the "packfile" header plus the pack as sideband
  // band-1 packets (an empty pack when there is nothing to send).
  const sendPack = (): void => {
    const pack = writePack(plan.send);
    chunks.push(encodePktLine('packfile\n'));
    for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  };
  const sendShallowInfo = (): void => {
    if (plan.shallow.length || plan.unshallow.length) {
      chunks.push(encodePktLine('shallow-info\n'));
      for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
      chunks.push(pktLineDelim());
    }
  };
  if (done || plan.haves.length === 0) {
    // No negotiation: straight to the packfile.
    sendShallowInfo();
    sendPack();
    chunks.push(pktLineFlush());
    return Buffer.concat(chunks);
  }
  // A negotiation round: the acknowledgments section first.
  chunks.push(encodePktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) chunks.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    chunks.push(encodePktLine('NAK\n'));
  }
  if (plan.send.length !== 0) {
    // No common ground to give up on yet: end the response; the client
    // sends another round (with more haves, or "done").
    chunks.push(pktLineFlush());
    return Buffer.concat(chunks);
  }
  // The client already holds everything: ready, then the packfile.
  chunks.push(encodePktLine('ready\n'));
  chunks.push(pktLineDelim());
  sendShallowInfo();
  sendPack();
  chunks.push(pktLineFlush());
  return Buffer.concat(chunks);
}

/**
 * Frame a fetch plan as a protocol v0 response body. Like v2, the pack is
 * only sent once the client says "done"; a negotiation round gets only the
 * ACK/NAK lines.
 */
function frameFetchV0(plan: FetchPlan, done: boolean): Buffer {
  const chunks: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) chunks.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    chunks.push(encodePktLine('NAK\n'));
  }
  if (!done) {
    chunks.push(pktLineFlush());
    return Buffer.concat(chunks);
  }
  for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.send.length) {
    const pack = writePack(plan.send);
    for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  chunks.push(pktLineFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------

function handleInfoRefs(store: Store, req: GitRequest, owner: string, repoName: string, service: string): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json404();
  const repo = store.getRepo(owner, repoName);
  if (!repo) return json404();
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body: v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack') };
}

/** Parse a v2 ls-refs request and answer it. */
function handleLsRefs(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): GitResponse {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const chunks: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (keep('HEAD')) {
    if (headOid) {
      chunks.push(encodePktLine(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
    } else if (symrefs) {
      chunks.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    chunks.push(encodePktLine(`${line}\n`));
  }
  chunks.push(pktLineFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
}

/** Parse a v2 fetch request and answer it. */
function handleFetchV2(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallows, depth);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: frameFetchV2(plan, done) };
}

/** Parse a v0 fetch request (want/have/done) and answer it. */
function handleFetchV0(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const first = line.slice(5).split(' ')[0]!;
      if (isObjectId(first)) wants.push(first);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallows, depth);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: frameFetchV0(plan, done) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle a receive-pack push: unpack the pack, apply the commands, report. */
function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  let packets: Array<{ kind: string; payload?: Buffer }>;
  let rawOffset: number;
  try {
    const split = splitPktLinesAndRaw(body);
    packets = split.packets;
    rawOffset = split.rawOffset;
  } catch (err) {
    return {
      status: 400,
      contentType: 'application/x-git-receive-pack-result',
      body: Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(`unpack ${(err as Error).message}\n`), pktLineFlush()])), pktLineFlush()]),
    };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    let capabilities = '';
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (capabilities.includes('side-band-64k')) sideband = true;
    const text = line.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) continue;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  // Unpack the pack (if any) into the repo's object store.
  let unpackError: string | null = null;
  if (rawOffset < body.length) {
    try {
      const pack = readPack(body.subarray(rawOffset), { resolveBase: (oid) => repo.objects.get(oid) });
      for (const object of pack.objects.values()) store.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      const verdict = applyPushCommand(store, repo, command);
      reportLines.push(verdict.ok ? `ok ${command.ref}` : `ng ${command.ref} ${verdict.reason}`);
    }
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => encodePktLine(`${line}\n`)), pktLineFlush()]);
  let responseBody: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < reportStream.length; offset += SIDEBAND_CHUNK) {
      const slice = reportStream.subarray(offset, Math.min(reportStream.length, offset + SIDEBAND_CHUNK));
      chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(pktLineFlush());
    responseBody = Buffer.concat(chunks);
  } else {
    responseBody = reportStream;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Apply one receive-pack command; returns ok or the ng reason. */
function applyPushCommand(store: Store, repo: Repo, command: PushCommand): { ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'no such ref' };
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) return { ok: false, reason: 'stale info' };
    repo.refs.delete(command.ref);
    return { ok: true };
  }
  const newObject = repo.objects.get(command.newOid);
  if (!newObject) return { ok: false, reason: 'object not found' };
  if (command.ref.startsWith('refs/heads/') && newObject.type !== 'commit') {
    return { ok: false, reason: 'not a commit' };
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'no such ref' };
  if (current !== command.oldOid) return { ok: false, reason: 'stale info' };
  if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git route
 * (the router falls through to the REST/404 handling).
 */
export function handleGit(store: Store, req: GitRequest): GitResponse | null {
  const parsed = parseGitPath(req.pathname);
  if (!parsed) return null;
  const { owner, repo: repoName, rest } = parsed;
  if (rest === 'info/refs') {
    if (req.method !== 'GET') return { status: 405, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
    const service = req.query.get('service') ?? '';
    return handleInfoRefs(store, req, owner, repoName, service);
  }
  if (rest === 'git-upload-pack') {
    if (req.method !== 'POST') return { status: 405, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
    const repo = store.getRepo(owner, repoName);
    if (!repo) return json404();
    let packets;
    try {
      packets = decodePktLines(req.body);
    } catch {
      return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
    }
    const firstLine = packets.find((packet) => packet.kind === 'data')?.payload?.toString('utf8') ?? '';
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2') || firstLine.startsWith('command=');
    if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(repo, packets);
    if (firstLine.startsWith('command=fetch')) return handleFetchV2(repo, packets);
    if (isV2) return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
    return handleFetchV0(repo, packets);
  }
  if (rest === 'git-receive-pack') {
    if (req.method !== 'POST') return { status: 405, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
    const repo = store.getRepo(owner, repoName);
    if (!repo) return json404();
    return handleReceivePack(store, repo, req.body);
  }
  return null;
}
