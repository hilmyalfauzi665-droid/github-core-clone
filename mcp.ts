// MCP: JSON-RPC 2.0 Streamable HTTP at POST /mcp. Modern era 2026-07-28:
// server/discover answers the capability handshake (no session, no SSE),
// then tools/list and tools/call drive the same store the REST surface uses.

import {
  isAuthenticated,
  jsonResponse,
  parseJsonBody,
  type HttpRequest,
  type HttpResponse,
} from './http.ts';
import { VIEWER, Store, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolText(object: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(object) }], structuredContent: object };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
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
  };
}

function issueView(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function pullView(repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; head: string; base: string; headSha: string; baseSha: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function requireArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw { code: -32602, message: `Unknown tool: ${name}` };
  const missing = requireArgs(args, tool.inputSchema.required);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER.login, repoName, description, isPrivate);
      if (!repo) return toolError('Repository already exists');
      return toolText(repoView(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('Repository not found');
      return toolText(repoView(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('Repository not found');
      const title = String(args.title);
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return toolText(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
      return toolText({ issues: issues.map((issue) => issueView(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('Repository not found');
      const title = String(args.title);
      const head = String(args.head);
      const base = String(args.base);
      const headTip = repo.refs.get(`refs/heads/${head}`);
      if (!headTip) return toolError(`Head branch does not exist: ${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!baseTip) return toolError(`Base branch does not exist: ${base}`);
      const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (existing) return toolError('A pull request already exists for this head and base');
      const pull = store.createPull(repo, { title, body: '', head, base, headSha: headTip, baseSha: baseTip });
      return toolText(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = store.findPull(repo, number);
      if (!pull) return toolError('Pull request not found');
      const result = store.mergePullRequest(repo, pull);
      if (!result.ok) return toolError(result.reason);
      return toolText({ sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
    }
    default:
      throw { code: -32602, message: `Unknown tool: ${name}` };
  }
}

interface JsonRpcError { code: number; message: string }
interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }

function rpcResult(id: string | number | null, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, error: JsonRpcError): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, error });
}

/** Handle POST /mcp; returns null when the path does not match. */
export function handleMcp(store: Store, req: HttpRequest): HttpResponse | null {
  if (req.pathname !== '/mcp') return null;
  if (req.method !== 'POST') return jsonResponse(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
  if (!isAuthenticated(req)) {
    return jsonResponse(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  const { value, error } = parseJsonBody(req.body);
  if (error) {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!isRecord(value) || typeof value.method !== 'string') {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const request = value as JsonRpcRequest;
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;
  const params = isRecord(request.params) ? request.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const protocolVersion = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
    : PROTOCOL_VERSIONS[0]!;

  switch (request.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcResult(id, {
        supportedVersions: [...PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      // Notifications carry no id and get no reply body.
      return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = params.name;
      const toolArgs = isRecord(params.arguments) ? params.arguments : {};
      if (typeof toolName !== 'string') return rpcError(id, { code: -32602, message: 'Missing tool name' });
      try {
        const result = callTool(store, toolName, toolArgs);
        return rpcResult(id, result);
      } catch (err) {
        if (isRecord(err) && typeof err.code === 'number') {
          return rpcError(id, { code: err.code, message: String(err.message ?? 'Tool error') });
        }
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      if (isNotification) {
        return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
      }
      return rpcError(id, { code: -32601, message: `Method not found: ${request.method}` });
  }
}
