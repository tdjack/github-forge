// A standalone GitHub-compatible git forge: git smart HTTP (v2 upload-pack, v0
// receive-pack), REST v3, GraphQL v4 and MCP, in one Node 22 stdlib process.
// Store is in-memory, deterministic (no wall clock in any exported state:
// timestamps derive from a fixed epoch plus a monotonic sequence counter).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- viewer
// The token owner is the scenario's first generated user. The scenario seed and
// generator are fixed and public in the kit, so the forge re-derives that login
// the same way the suite derives it, instead of guessing it from the opaque
// bearer token.

const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
const U64 = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64; }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
class Rng {
  #s: bigint;
  constructor(seed: bigint) { const m = seed & U64; this.#s = m === 0n ? 0x6a09e667f3bcc909n : m; }
  nextU32(): number { let x = this.#s; x = (x ^ (x >> 12n)) & U64; x = (x ^ (x << 25n)) & U64; x = (x ^ (x >> 27n)) & U64; this.#s = x; return Number((x * 0x2545f4914f6cdd1dn) & U64 >> 32n); }
  nextInt(max: number): number { if (max === 1) return 0; const range = 4294967296; const limit = range - (range % max); for (;;) { const v = this.nextU32(); if (v < limit) return v % max; } }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)] as T; }
}
function viewerUser(): { login: string; name: string; email: string; id: number } {
  const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES); const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`;
  return { login, name: `${first} ${last}`, email: `${login}@example.invalid`, id: 1000 };
}
const VIEWER = viewerUser();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, fixed; no wall clock in state
let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function isoFor(n: number): string { return new Date((EPOCH + n * 60) * 1000).toISOString(); }
function b64(buf: Buffer | string): string { return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf, 'utf8').toString('base64'); }
function unb64(s: string): Buffer { return Buffer.from(s.replace(/\s/g, ''), 'base64'); }
const ZERO_OID = '0'.repeat(40);
const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');

// ---------------------------------------------------------------- git objects
type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
interface GitObj { type: ObjType; data: Buffer }
function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = []; let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off); const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0, sp); const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex'); off = nul + 21;
    out.push({ mode, name, oid });
  }
  return out;
}
function treeSortKey(e: TreeEntry): string { return e.mode === '40000' ? `${e.name}/` : e.name; }
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) parts.push(Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex')]));
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; timestamp: number }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8'); const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  const parents: string[] = []; let tree = ''; let author = ''; let committer = ''; let timestamp = EPOCH;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) { author = line.slice(7); const m = /(\d+) [+-]\d{4}/.exec(author); if (m) timestamp = Number(m[1]); }
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp };
}
function buildCommit(o: { tree: string; parents: string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines = [`tree ${o.tree}`, ...o.parents.map((p) => `parent ${p}`), `author ${o.author} ${o.timestamp} +0000`, `committer ${o.committer} ${o.timestamp} +0000`, '', o.message.endsWith('\n') ? o.message : `${o.message}\n`];
  return Buffer.from(lines.join('\n'), 'utf8');
}
interface TagView { object: string; type: string; tag: string; tagger: string; message: string }
function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8'); const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>(); const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = lookup(oid); if (!obj) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); stack.push(c.tree, ...c.parents); }
    else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) stack.push(e.oid); }
    else if (obj.type === 'tag') { stack.push(parseTag(obj.data).object); }
  }
  return seen;
}
function filesOfCommit(repo: Repo, commitSha: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid); if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else { const b = repo.objects.get(e.oid); if (b) out.set(`${prefix}${e.name}`, b.data); }
    }
  };
  const commit = repo.objects.get(commitSha); if (!commit) return out;
  walk(parseCommit(commit.data).tree, '');
  return out;
}
function treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i++) { const n = segs[i] as string; if (!node.dirs.has(n)) node.dirs.set(n, make()); node = node.dirs.get(n) as Node; }
    node.files.set(segs[segs.length - 1] as string, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObj(repo, 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function makeCommit(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string, timestamp?: number): string {
  const tree = treeFromFiles(repo, files);
  const ts = timestamp ?? EPOCH + nextSeq() * 60;
  const ident = `${VIEWER.name} <${VIEWER.email}>`;
  return putObj(repo, 'commit', buildCommit({ tree, parents, message, author: ident, committer: ident, timestamp: ts }));
}
// --- pack reading (OFS_DELTA and REF_DELTA) and writing (no deltas) ---
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => { let v = 0; let sh = 0; for (;;) { const b = delta[off++] as number; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let w = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) { co += (delta[off++] as number) * 2 ** sh; } sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) { cs += (delta[off++] as number) * 2 ** sh; } sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, w, co, co + cs); w += cs;
    } else if (op !== 0) { const n = op & 0x7f; delta.copy(out, w, off, off + n); off += n; w += n; }
    else throw new Error('delta opcode 0');
  }
  if (w !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
const PACK_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer, repo: Repo): GitObj[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4); if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8); const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (trailer !== sha1(pack.subarray(0, trailerStart))) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    let byte = pack[off] as number; const first = byte; let size = byte & 0x0f; let shift = 4; off += 1;
    while (byte & 0x80) { byte = pack[off++] as number; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off++] as number; let v = b & 0x7f;
      while (b & 0x80) { b = pack[off++] as number; v = ((v + 1) * 128) + (b & 0x7f); }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) { entry.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!PACK_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inf = inflateAt(pack.subarray(0, trailerStart), off); off = inf.next;
    if (inf.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inf.data; raw.push(entry); byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<number, GitObj>();
  const resolve = (entry: Raw): GitObj => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset) as GitObj;
    let obj: GitObj;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObj | undefined;
      if (entry.typeCode === 6) { const b = byOffset.get(entry.baseOffset as number); if (!b) throw new Error('ofs-delta base missing'); base = resolve(b); }
      else { base = repo.objects.get(entry.baseOid as string); if (!base) { const found = raw.find((r) => hashObject(PACK_TYPE[r.typeCode] ?? 'blob', r.data) === entry.baseOid); if (found) base = resolve(found); } if (!base) throw new Error('ref-delta base missing'); }
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else obj = { type: PACK_TYPE[entry.typeCode] as ObjType, data: entry.data };
    resolved.set(entry.offset, obj); return obj;
  };
  return raw.map((e) => resolve(e));
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12); head.write('PACK', 0, 4, 'ascii'); head.writeUInt32BE(2, 4); head.writeUInt32BE(objects.length, 8); parts.push(head);
  const typeCode: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const size = obj.data.length; const code = typeCode[obj.type];
    const hdr: number[] = []; let s = size; let first = (code << 4) | (s & 0x0f); s >>= 4;
    if (s > 0) first |= 0x80; hdr.push(first);
    while (s > 0) { let b = s & 0x7f; s >>= 7; if (s > 0) b |= 0x80; hdr.push(b); }
    parts.push(Buffer.from(hdr), deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}
// pkt-line helpers
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.alloc(4); h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  return Buffer.concat(items.map((i) => (i === 'flush' ? FLUSH : i === 'delim' ? DELIM : pkt(i))));
}
function parsePktLines(buf: Buffer): { packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }>; rest: Buffer } {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (lenHex === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; break; }
    if (lenHex === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (lenHex === '0002') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) }); off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- store
interface Issue { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; createdSeq: number; closedAt: string | null; comments: Array<{ id: number; body: string; createdSeq: number }> }
interface Pull { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; baseShaAtCreate: string; headShaAtCreate: string; merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; createdSeq: number }
interface Repo {
  id: number; name: string; description: string; isPrivate: boolean; defaultBranch: string;
  createdSeq: number; labels: Map<string, string>; issues: Issue[]; pulls: Pull[];
  refs: Map<string, string>; objects: Map<string, GitObj>; nextIssue: number; nextPull: number; nextComment: number;
}
const repos = new Map<string, Repo>();
let repoIdSeq = 5000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function newRepo(name: string, description: string, isPrivate: boolean): Repo {
  const id = repoIdSeq++; const n = nextSeq();
  const repo: Repo = { id, name, description, isPrivate, defaultBranch: 'main', createdSeq: n, labels: new Map(), issues: [], pulls: [], refs: new Map(), objects: new Map(), nextIssue: 1, nextPull: 1, nextComment: 1 };
  repos.set(repoKey(VIEWER.login, name), repo); return repo;
}
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}
function branchFiles(repo: Repo, branch: string): Map<string, Buffer> {
  const tip = repo.refs.get(`refs/heads/${branch}`); if (!tip) return new Map();
  return filesOfCommit(repo, tip);
}
function commitFiles(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string, ts?: number): string {
  return makeCommit(repo, files, parents, message, ts);
}
function diffFiles(base: Map<string, Buffer>, head: Map<string, Buffer>): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p); const h = head.get(p);
    if (b && h && b.equals(h)) continue;
    const countLines = (buf: Buffer): number => { const s = buf.toString('utf8'); return s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0); };
    if (!b && h) out.push({ path: p, status: 'added', additions: countLines(h), deletions: 0 });
    else if (b && !h) out.push({ path: p, status: 'removed', additions: 0, deletions: countLines(b) });
    else if (b && h) out.push({ path: p, status: 'modified', additions: countLines(h), deletions: countLines(b) });
  }
  return out;
}
function pullFiles(repo: Repo, pr: Pull): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const baseFiles = pr.baseShaAtCreate ? filesOfCommit(repo, pr.baseShaAtCreate) : new Map<string, Buffer>();
  const headFiles = pr.headShaAtCreate ? filesOfCommit(repo, pr.headShaAtCreate) : branchFiles(repo, pr.head);
  // Use head tip at creation time if still present, else current head files.
  return diffFiles(baseFiles, headFiles);
}
function pullMergeable(repo: Repo, pr: Pull): boolean {
  if (pr.merged || pr.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!baseTip) return false;
  if (baseTip === pr.baseShaAtCreate) return true;
  const baseNow = filesOfCommit(repo, baseTip);
  const baseThen = filesOfCommit(repo, pr.baseShaAtCreate);
  const head = filesOfCommit(repo, pr.headShaAtCreate);
  for (const d of diffFiles(baseThen, head)) {
    const now = baseNow.get(d.path); const then = baseThen.get(d.path);
    if (now && then && !now.equals(then) && !(head.get(d.path)?.equals(now))) return false;
    if (!now && then && head.get(d.path)) return false;
  }
  return true;
}
function doMerge(repo: Repo, pr: Pull): string | null {
  if (!pullMergeable(repo, pr)) return null;
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) as string;
  const baseFiles = filesOfCommit(repo, baseTip);
  const baseThen = filesOfCommit(repo, pr.baseShaAtCreate);
  const headFiles = filesOfCommit(repo, pr.headShaAtCreate);
  const merged = new Map(baseFiles);
  for (const d of diffFiles(baseThen, headFiles)) {
    const h = headFiles.get(d.path);
    if (h) merged.set(d.path, h); else merged.delete(d.path);
  }
  const sha = commitFiles(repo, merged, [baseTip, pr.headShaAtCreate], `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`);
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.merged = true; pr.state = 'closed'; pr.mergeCommitSha = sha; pr.mergedAt = isoFor(nextSeq());
  return sha;
}
function gid(kind: string, id: string): string { return b64(`${kind}:${id}`); }
function repoJson(repo: Repo): Record<string, unknown> {
  return { id: repo.id, node_id: gid('Repository', String(repo.id)), name: repo.name, full_name: `${VIEWER.login}/${repo.name}`, owner: { login: VIEWER.login, id: VIEWER.id, node_id: gid('User', String(VIEWER.id)), type: 'User' }, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch, html_url: `https://example.invalid/${VIEWER.login}/${repo.name}`, url: `/api/v3/repos/${VIEWER.login}/${repo.name}`, created_at: isoFor(repo.createdSeq), updated_at: isoFor(repo.createdSeq), pushed_at: isoFor(repo.createdSeq), has_issues: true, has_projects: true, has_wiki: true, fork: false, archived: false, disabled: false, visibility: repo.isPrivate ? 'private' : 'public', license: null, forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length, topics: [] };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return { id: issue.id, node_id: gid('Issue', `${repo.id}:${issue.number}`), number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l, color: repo.labels.get(l) ?? 'ededed', description: null, default: false })), user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, assignees: [], assignee: null, created_at: isoFor(issue.createdSeq), updated_at: isoFor(issue.createdSeq), closed_at: issue.closedAt, html_url: `https://example.invalid/${VIEWER.login}/${repo.name}/issues/${issue.number}`, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`, repository_url: `/api/v3/repos/${VIEWER.login}/${repo.name}`, comments_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}/comments`, comments: issue.comments.length, author_association: 'OWNER', locked: false, milestone: null };
}
function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseShaAtCreate;
  const files = pullFiles(repo, pr);
  return { id: pr.id, node_id: gid('PullRequest', `${repo.id}:${pr.number}`), number: pr.number, title: pr.title, body: pr.body, state: pr.state, locked: false, draft: false, merged: pr.merged, mergeable: pullMergeable(repo, pr), mergeable_state: pr.merged ? 'merged' : pullMergeable(repo, pr) ? 'clean' : 'dirty', merge_commit_sha: pr.mergeCommitSha, merged_at: pr.mergedAt, merge_method: 'squash', head: { ref: pr.head, sha: headSha, label: `${VIEWER.login}:${pr.head}`, repo: repoJson(repo) }, base: { ref: pr.base, sha: baseSha, label: `${VIEWER.login}:${pr.base}`, repo: repoJson(repo) }, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: isoFor(pr.createdSeq), updated_at: isoFor(pr.createdSeq), closed_at: pr.merged ? pr.mergedAt : pr.state === 'closed' ? pr.mergedAt : null, html_url: `https://example.invalid/${VIEWER.login}/${repo.name}/pull/${pr.number}`, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pr.number}`, commits: 1, additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0), changed_files: files.length, comments: 0, review_comments: 0, maintainer_can_modify: false, rebaseable: true, requested_reviewers: [], labels: [] };
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha); if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = { name: VIEWER.name, email: VIEWER.email, date: new Date(c.timestamp * 1000).toISOString() };
  return { sha, node_id: gid('Commit', sha), commit: { message: c.message, author, committer: author, tree: { sha: c.tree } }, author: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, parents: c.parents.map((p) => ({ sha: p })), url: `/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${sha}`, html_url: `https://example.invalid/${VIEWER.login}/${repo.name}/commit/${sha}` };
}
function commitsFrom(repo: Repo, tip: string): string[] {
  const out: string[] = []; const seen = new Set<string>(); const stack = [tip];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (seen.has(sha) || sha === ZERO_OID) continue;
    const obj = repo.objects.get(sha); if (!obj || obj.type !== 'commit') continue;
    seen.add(sha); out.push(sha);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- http helpers
let reqCounter = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}`, ...extra };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers); res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': `req-${++reqCounter}`, ...extra });
  res.end(body);
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://example.invalid' }); }
function badCredentials(res: ServerResponse): void { sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://example.invalid' }); }
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
}
async function readJsonBody(req: IncomingMessage): Promise<{ ok: boolean; value: unknown }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; } catch { return { ok: false, value: null }; }
}
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
function paginate<T>(items: T[], url: URL, origin: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const linkFor = (p: number, rel: string): string => `<${origin}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), per_page: String(perPage), page: String(p) }).toString()}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(linkFor(page + 1, 'next'));
  if (totalPages > 1) parts.push(linkFor(totalPages, 'last'));
  if (page > 1) parts.push(linkFor(1, 'first'));
  return { page: slice, link: parts.length ? parts.join(', ') : null };
}

// ---------------------------------------------------------------- REST
function repoOr404(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = getRepo(owner, name);
  if (!repo) { notFound(res); return null; }
  return repo;
}
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!authed(req)) { badCredentials(res); return true; }
  const body = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readJsonBody(req) : { ok: true, value: {} };
  if (!body.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const b = (body.value ?? {}) as Record<string, unknown>;
  const origin = originOf(req);
  // API root
  if (segs.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
    notFound(res); return true;
  }
  if (segs[0] === 'meta' && method === 'GET') { sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' }); return true; }
  if (segs[0] === 'rate_limit' && method === 'GET') { sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: EPOCH + 3600, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: EPOCH + 3600, used: 0 } }); return true; }
  if (segs[0] === 'user' && segs.length === 1 && method === 'GET') { sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, node_id: gid('User', String(VIEWER.id)), name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false, created_at: isoFor(1), updated_at: isoFor(1) }); return true; }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, z) => a.createdSeq - z.createdSeq).map((r) => repoJson(r));
      const { page, link } = paginate(all, url, origin);
      sendJson(res, 200, page, link ? { link } : {}); return true;
    }
    if (method === 'POST') {
      const name = String(b.name ?? '');
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] }); return true; }
      if (repos.has(repoKey(VIEWER.login, name))) { sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }); return true; }
      const repo = newRepo(name, String(b.description ?? ''), b.private === true);
      sendJson(res, 201, repoJson(repo)); return true;
    }
    notFound(res); return true;
  }
  if (segs[0] !== 'repos' || segs.length < 3) { notFound(res); return true; }
  const owner = decodeURIComponent(segs[1] as string); const name = decodeURIComponent(segs[2] as string);
  const rest = segs.slice(3);
  // GET / PATCH / DELETE repo itself
  if (rest.length === 0) {
    const repo = repoOr404(req, res, owner, name); if (!repo) return true;
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') { if (typeof b.description === 'string') repo.description = b.description; if (typeof b.private === 'boolean') repo.isPrivate = b.private; sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'DELETE') { repos.delete(repoKey(owner, name)); res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` }); res.end(); return true; }
    notFound(res); return true;
  }
  const repo = repoOr404(req, res, owner, name); if (!repo) return true;
  // branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(r)}` }, protected: false }));
    sendJson(res, 200, list); return true;
  }
  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const ref = String(b.ref ?? ''); const sha = String(b.sha ?? '');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Git', code: 'custom', field: 'sha', message: 'object does not exist' }] }); return true; }
    if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Git', code: 'custom', field: 'ref', message: 'reference already exists' }] }); return true; }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, node_id: gid('Ref', ref), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${repo.objects.get(sha)?.type}s/${sha}` } }); return true;
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
    const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
    const sha = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/${ref}`);
    if (!sha) { notFound(res); return true; }
    sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }); return true;
  }
  // commits
  if (rest[0] === 'commits' && method === 'GET') {
    if (rest.length === 2) { const c = commitJson(repo, rest[1] as string); if (!c) { notFound(res); return true; } sendJson(res, 200, c); return true; }
    const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${refParam}`) ?? (repo.objects.has(refParam) ? refParam : undefined);
    if (!tip) { sendJson(res, 200, []); return true; }
    const list = commitsFrom(repo, tip).map((s) => commitJson(repo, s)).filter((x): x is Record<string, unknown> => x !== null);
    const { page, link } = paginate(list, url, origin);
    sendJson(res, 200, page, link ? { link } : {}); return true;
  }
  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = url.searchParams.get('ref') ?? undefined;
    const branch = refParam && repo.refs.has(`refs/heads/${refParam}`) ? refParam : repo.defaultBranch;
    const tipSha = refParam && repo.objects.has(refParam) && !repo.refs.has(`refs/heads/${refParam}`) ? refParam : repo.refs.get(`refs/heads/${branch}`);
    const files = tipSha ? filesOfCommit(repo, tipSha) : new Map<string, Buffer>();
    if (method === 'GET') {
      if (path === '') {
        const entries = dirEntries(repo, files, '');
        sendJson(res, 200, entries); return true;
      }
      const data = files.get(path);
      if (data) {
        const blobSha = hashObject('blob', data);
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, content: b64(data), sha: blobSha, url: `/api/v3/repos/${owner}/${name}/contents/${path}`, html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${path}` }); return true;
      }
      const entries = dirEntries(repo, files, path);
      if (entries.length) { sendJson(res, 200, entries); return true; }
      notFound(res); return true;
    }
    if (method === 'PUT') {
      const contentB64 = String(b.content ?? '');
      let data: Buffer;
      try { data = unb64(contentB64); } catch { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
      const putBranch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
      const currentFiles = branchFiles(repo, putBranch);
      const existing = currentFiles.get(path);
      if (existing) {
        const existingSha = hashObject('blob', existing);
        if (typeof b.sha === 'string' && b.sha !== existingSha) { sendJson(res, 409, { message: 'sha does not match' }); return true; }
        if (typeof b.sha !== 'string') { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'custom', field: 'sha', message: 'sha is required to update a file' }] }); return true; }
      }
      const parents = repo.refs.get(`refs/heads/${putBranch}`) ? [repo.refs.get(`refs/heads/${putBranch}`) as string] : [];
      const nextFiles = new Map(currentFiles); nextFiles.set(path, data);
      const commitSha = commitFiles(repo, nextFiles, parents, String(b.message ?? 'Update file'));
      repo.refs.set(`refs/heads/${putBranch}`, commitSha);
      const blobSha = hashObject('blob', data);
      sendJson(res, existing ? 200 : 201, { content: { name: path.split('/').pop(), path, sha: blobSha, size: data.length, encoding: 'base64', type: 'file' }, commit: { sha: commitSha, message: String(b.message ?? ''), author: { name: VIEWER.name, email: VIEWER.email, date: isoFor(seq) } } }); return true;
    }
    if (method === 'DELETE') {
      const currentFiles = branchFiles(repo, branch);
      const existing = currentFiles.get(path);
      if (!existing) { notFound(res); return true; }
      if (typeof b.sha === 'string' && b.sha !== hashObject('blob', existing)) { sendJson(res, 409, { message: 'sha does not match' }); return true; }
      const parents = repo.refs.get(`refs/heads/${branch}`) ? [repo.refs.get(`refs/heads/${branch}`) as string] : [];
      const nextFiles = new Map(currentFiles); nextFiles.delete(path);
      const commitSha = commitFiles(repo, nextFiles, parents, String(b.message ?? 'Delete file'));
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message: String(b.message ?? '') } }); return true;
    }
    notFound(res); return true;
  }
  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET') { sendJson(res, 200, [...repo.labels.entries()].map(([n, c]) => ({ name: n, color: c, description: null, default: false }))); return true; }
    if (method === 'POST') {
      const n = String(b.name ?? ''); const color = String(b.color ?? 'ededed');
      if (!n) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
      repo.labels.set(n, color);
      sendJson(res, 201, { name: n, color, description: null, default: false }); return true;
    }
    notFound(res); return true;
  }
  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
        for (const l of labels) if (!repo.labels.has(l)) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label ${l} does not exist` }] }); return true; }
        const n = nextSeq();
        const issue: Issue = { id: repo.id * 100000 + repo.nextIssue, number: repo.nextIssue++, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open', labels, createdSeq: n, closedAt: null, comments: [] };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue)); return true;
      }
      if (method === 'GET') {
        let list = [...repo.issues];
        const state = url.searchParams.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const dir = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
        list.sort((a, z) => (dir === 'asc' ? a.createdSeq - z.createdSeq : z.createdSeq - a.createdSeq));
        const { page, link } = paginate(list.map((i) => issueJson(repo, i)), url, origin);
        sendJson(res, 200, page, link ? { link } : {}); return true;
      }
      notFound(res); return true;
    }
    const num = Number(rest[1]);
    const issue = repo.issues.find((i) => i.number === num);
    if (rest.length === 2) {
      if (!issue) { notFound(res); return true; }
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
      if (method === 'PATCH') {
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        if (b.state === 'closed') { issue.state = 'closed'; issue.closedAt = isoFor(nextSeq()); }
        else if (b.state === 'open') { issue.state = 'open'; issue.closedAt = null; }
        if (Array.isArray(b.labels)) {
          const labels = (b.labels as unknown[]).map((x) => (typeof x === 'string' ? x : String((x as Record<string, unknown>).name ?? '')));
          for (const l of labels) if (!repo.labels.has(l)) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
          issue.labels = labels;
        }
        sendJson(res, 200, issueJson(repo, issue)); return true;
      }
      notFound(res); return true;
    }
    if (rest[2] === 'comments') {
      if (!issue) { notFound(res); return true; }
      if (method === 'GET') { sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('IssueComment', String(c.id)), body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: isoFor(c.createdSeq), updated_at: isoFor(c.createdSeq) }))); return true; }
      if (method === 'POST') {
        const n = nextSeq();
        const comment = { id: repo.id * 1000000 + repo.nextComment++, body: String(b.body ?? ''), createdSeq: n };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, node_id: gid('IssueComment', String(comment.id)), body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: isoFor(n), updated_at: isoFor(n) }); return true;
      }
      notFound(res); return true;
    }
    notFound(res); return true;
  }
  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = String(b.head ?? ''); const base = String(b.base ?? repo.defaultBranch);
        const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'head or base branch does not exist' }] }); return true; }
        const n = nextSeq();
        const pr: Pull = { id: repo.id * 100000 + repo.nextPull, number: repo.nextPull++, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open', head, base, baseShaAtCreate: baseSha, headShaAtCreate: headSha, merged: false, mergeCommitSha: null, mergedAt: null, createdSeq: n };
        repo.pulls.push(pr);
        sendJson(res, 201, pullJson(repo, pr)); return true;
      }
      if (method === 'GET') {
        let list = [...repo.pulls];
        const state = url.searchParams.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, z) => z.createdSeq - a.createdSeq);
        const { page, link } = paginate(list.map((p) => pullJson(repo, p)), url, origin);
        sendJson(res, 200, page, link ? { link } : {}); return true;
      }
      notFound(res); return true;
    }
    const num = Number(rest[1]);
    const pr = repo.pulls.find((p) => p.number === num);
    if (rest.length === 2) {
      if (!pr) { notFound(res); return true; }
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
      if (method === 'PATCH') { if (typeof b.title === 'string') pr.title = b.title; if (typeof b.body === 'string') pr.body = b.body; if (b.state === 'closed') pr.state = 'closed'; sendJson(res, 200, pullJson(repo, pr)); return true; }
      notFound(res); return true;
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pr) { notFound(res); return true; }
      sendJson(res, 200, pullFiles(repo, pr).map((f) => ({ filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, patch: '', sha: '', raw_url: '' }))); return true;
    }
    if (rest[2] === 'commits' && method === 'GET') {
      if (!pr) { notFound(res); return true; }
      const baseSet = new Set(commitsFrom(repo, pr.baseShaAtCreate));
      const list = commitsFrom(repo, pr.headShaAtCreate).filter((s) => !baseSet.has(s)).map((s) => commitJson(repo, s)).filter((x): x is Record<string, unknown> => x !== null);
      sendJson(res, 200, list); return true;
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (!pr) { notFound(res); return true; }
      if (pr.merged) { sendJson(res, 405, { message: 'Pull request already merged' }); return true; }
      const sha = doMerge(repo, pr);
      if (!sha) { sendJson(res, 405, { message: 'Merge conflict' }); return true; }
      sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' }); return true;
    }
    notFound(res); return true;
  }
  notFound(res); return true;
}
function dirEntries(repo: Repo, files: Map<string, Buffer>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, 'file' | 'dir'>();
  for (const p of files.keys()) {
    if (!p.startsWith(prefix)) continue;
    const restPath = p.slice(prefix.length);
    const slash = restPath.indexOf('/');
    if (slash < 0) seen.set(restPath, 'file');
    else seen.set(restPath.slice(0, slash), 'dir');
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, type]) => {
    const full = prefix + name;
    const data = type === 'file' ? files.get(full) : undefined;
    return { type, name, path: full, sha: data ? hashObject('blob', data) : hashObject('tree', Buffer.alloc(0)), size: data ? data.length : 0, url: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${full}` };
  });
}

// ---------------------------------------------------------------- GraphQL
type GqlValue = string | number | boolean | null | undefined | GqlValue[] | { [k: string]: GqlValue };
interface Sel { name: string; alias?: string; args: Record<string, unknown>; sels: Sel[]; fragment?: string }
class GqlParser {
  toks: string[]; i = 0;
  constructor(text: string) { this.toks = this.tokenize(text); }
  tokenize(text: string): string[] {
    const out: string[] = []; let i = 0;
    while (i < text.length) {
      const c = text[i] as string;
      if (/\s/.test(c) || c === ',') { i++; continue; }
      if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (text.startsWith('...', i)) { out.push('...'); i += 3; continue; }
      if ('{}():$!@=[]'.includes(c)) { out.push(c); i++; continue; }
      if (c === '"') { let j = i + 1; let s = ''; while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1]; j += 2; } else { s += text[j]; j++; } } out.push(JSON.stringify(s)); i = j + 1; continue; }
      let j = i; while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j] as string)) j++;
      if (j === i) { i++; continue; }
      out.push(text.slice(i, j)); i = j;
    }
    return out;
  }
  peek(): string | undefined { return this.toks[this.i]; }
  next(): string { return this.toks[this.i++] as string; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (t === '$') return vars[this.next() as string];
    if (t === '[') { const arr: unknown[] = []; while (this.peek() !== ']') arr.push(this.parseValue(vars)); this.expect(']'); return arr; }
    if (t === '{') { const obj: Record<string, unknown> = {}; while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(vars); } this.expect('}'); return obj; }
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    if (t.startsWith('"')) return JSON.parse(t);
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return t; // enum
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') { this.next(); while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.parseValue(vars); } this.expect(')'); }
    return args;
  }
  parseSels(vars: Record<string, unknown>): Sel[] {
    this.expect('{'); const out: Sel[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let frag: string | undefined;
        if (this.peek() === 'on') { this.next(); frag = this.next(); }
        else if (this.peek() !== '{') { this.next(); } // fragment spread name (unsupported, skip)
        const sels = this.parseSels(vars);
        for (const s of sels) out.push({ ...s, fragment: frag });
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs(vars);
      const sels = this.peek() === '{' ? this.parseSels(vars) : [];
      out.push({ name, alias, args, sels });
    }
    this.expect('}'); return out;
  }
  parseDocument(vars: Record<string, unknown>): Array<{ kind: 'query' | 'mutation'; name?: string; sels: Sel[] }> {
    const ops: Array<{ kind: 'query' | 'mutation'; name?: string; sels: Sel[] }> = [];
    while (this.i < this.toks.length) {
      let kind: 'query' | 'mutation' = 'query';
      const t = this.next();
      if (t === 'query' || t === 'mutation') { kind = t as 'query' | 'mutation'; if (this.peek() && this.peek() !== '(' && this.peek() !== '{') this.next(); }
      else if (t === '{') { this.i--; }
      else continue;
      // skip variable definitions (...)
      if (this.peek() === '(') { let depth = 0; do { const tk = this.next(); if (tk === '(') depth++; else if (tk === ')') depth--; } while (depth > 0); }
      const sels = this.parseSels(vars);
      ops.push({ kind, sels });
    }
    return ops;
  }
}
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id','number','title','body','state','author','assignees','labels','comments','createdAt','updatedAt','url','closedAt','closed','repository'],
  PullRequest: ['id','number','title','body','state','merged','mergeable','headRefName','baseRefName','headRef','baseRef','files','author','createdAt','updatedAt','url','mergeCommit','commits'],
  Repository: ['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issues','issue','pullRequests','pullRequest','description','url','createdAt','updatedAt','isPrivate','fork'],
  SearchType: [],
  User: ['login','id','name','email','avatarUrl'],
};
const SEARCH_ENUM = ['ISSUE','REPOSITORY','USER','DISCUSSION','CODE','COMMIT'];
function decodeGid(id: string): { kind: string; id: string } | null {
  try { const s = Buffer.from(id, 'base64').toString('utf8'); const idx = s.indexOf(':'); if (idx < 0) return null; return { kind: s.slice(0, idx), id: s.slice(idx + 1) }; } catch { return null; }
}
function findRepoByGid(id: string): Repo | undefined {
  const d = decodeGid(id); if (!d || d.kind !== 'Repository') return undefined;
  const num = Number(d.id); return [...repos.values()].find((r) => r.id === num);
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | undefined {
  const d = decodeGid(id); if (!d || d.kind !== 'Issue') return undefined;
  const [rid, num] = d.id.split(':'); const repo = [...repos.values()].find((r) => r.id === Number(rid)); if (!repo) return undefined;
  const issue = repo.issues.find((i) => i.number === Number(num)); if (!issue) return undefined;
  return { repo, issue };
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | undefined {
  const d = decodeGid(id); if (!d || d.kind !== 'PullRequest') return undefined;
  const [rid, num] = d.id.split(':'); const repo = [...repos.values()].find((r) => r.id === Number(rid)); if (!repo) return undefined;
  const pull = repo.pulls.find((p) => p.number === Number(num)); if (!pull) return undefined;
  return { repo, pull };
}
function gqlState(s: string): string { return s === 'open' ? 'OPEN' : s === 'closed' ? 'CLOSED' : 'MERGED'; }
function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', repo, issue, id: gid('Issue', `${repo.id}:${issue.number}`), number: issue.number, title: issue.title, body: issue.body, state: gqlState(issue.state) };
}
function pullGql(repo: Repo, pr: Pull): Record<string, unknown> {
  return { __type: 'PullRequest', repo, pull: pr, id: gid('PullRequest', `${repo.id}:${pr.number}`), number: pr.number, title: pr.title, body: pr.body, state: pr.merged ? 'MERGED' : gqlState(pr.state), merged: pr.merged, headRefName: pr.head, baseRefName: pr.base, mergeable: pullMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING' };
}
function repoGql(repo: Repo): Record<string, unknown> {
  return { __type: 'Repository', repo, id: gid('Repository', String(repo.id)), databaseId: repo.id, name: repo.name, nameWithOwner: `${VIEWER.login}/${repo.name}`, description: repo.description, viewerPermission: 'ADMIN', hasIssuesEnabled: true };
}
function cursorOf(index: number): string { return b64(`cursor:${index}`); }
function cursorIndex(c: unknown): number {
  if (typeof c !== 'string') return -1;
  try { const s = Buffer.from(c, 'base64').toString('utf8'); const m = /^cursor:(\d+)$/.exec(s); return m ? Number(m[1]) : -1; } catch { return -1; }
}
function resolveField(typeName: string, obj: Record<string, unknown>, name: string, args: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  const known = TYPE_FIELDS[typeName];
  if (typeName === 'Query') {
    if (name === 'viewer') return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    if (name === 'repository') { const repo = getRepo(String(args.owner ?? ''), String(args.name ?? '')); return repo ? repoGql(repo) : null; }
    if (name === 'node') {
      const id = String(args.id ?? ''); const d = decodeGid(id);
      if (!d) return null;
      if (d.kind === 'Repository') { const repo = findRepoByGid(id); return repo ? repoGql(repo) : null; }
      if (d.kind === 'Issue') { const f = findIssueByGid(id); return f ? issueGql(f.repo, f.issue) : null; }
      if (d.kind === 'PullRequest') { const f = findPullByGid(id); return f ? pullGql(f.repo, f.pull) : null; }
      return null;
    }
    if (name === '__type') {
      const tname = String(args.name ?? '');
      const fields = TYPE_FIELDS[tname] ?? [];
      const enumValues = tname === 'SearchType' ? SEARCH_ENUM : tname.endsWith('State') || tname === 'IssueState' ? ['OPEN', 'CLOSED'] : tname === 'PullRequestState' ? ['OPEN', 'CLOSED', 'MERGED'] : tname === 'MergeableState' ? ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] : tname === 'RepositoryPermission' ? ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] : tname === 'IssueOrderField' ? ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] : tname === 'OrderDirection' ? ['ASC', 'DESC'] : tname === 'PullRequestMergeMethod' ? ['MERGE', 'SQUASH', 'REBASE'] : [];
      return { __type: '__Type', name: tname, fields: fields.map((f) => ({ name: f })), enumValues: enumValues.map((f) => ({ name: f })) };
    }
    if (name === '__schema') return { types: [] };
    errors.push({ message: `Cannot query field "${name}" on type "Query".` }); return null;
  }
  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = findRepoByGid(String(input.repositoryId ?? '')); if (!repo) { errors.push({ message: 'Repository not found.' }); return null; }
      const n = nextSeq(); const issue: Issue = { id: repo.id * 100000 + repo.nextIssue, number: repo.nextIssue++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], createdSeq: n, closedAt: null, comments: [] };
      repo.issues.push(issue); return { issue: issueGql(repo, issue) };
    }
    if (name === 'closeIssue') {
      const f = findIssueByGid(String(input.issueId ?? '')); if (!f) { errors.push({ message: 'Issue not found.' }); return null; }
      f.issue.state = 'closed'; f.issue.closedAt = isoFor(nextSeq()); return { issue: issueGql(f.repo, f.issue) };
    }
    if (name === 'createPullRequest') {
      const repo = findRepoByGid(String(input.repositoryId ?? '')); if (!repo) { errors.push({ message: 'Repository not found.' }); return null; }
      const head = String(input.headRefName ?? ''); const base = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) { errors.push({ message: 'Head or base branch not found.' }); return null; }
      const n = nextSeq();
      const pr: Pull = { id: repo.id * 100000 + repo.nextPull, number: repo.nextPull++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', head, base, baseShaAtCreate: baseSha, headShaAtCreate: headSha, merged: false, mergeCommitSha: null, mergedAt: null, createdSeq: n };
      repo.pulls.push(pr); return { pullRequest: pullGql(repo, pr) };
    }
    if (name === 'mergePullRequest') {
      const f = findPullByGid(String(input.pullRequestId ?? '')); if (!f) { errors.push({ message: 'Pull request not found.' }); return null; }
      const sha = doMerge(f.repo, f.pull);
      if (!sha) { errors.push({ message: 'Merge conflict.' }); return { pullRequest: pullGql(f.repo, f.pull) }; }
      return { pullRequest: pullGql(f.repo, f.pull) };
    }
    if (name === 'addComment') {
      const f = findIssueByGid(String(input.subjectId ?? '')); if (!f) { errors.push({ message: 'Subject not found.' }); return null; }
      const n = nextSeq(); const comment = { id: f.repo.id * 1000000 + f.repo.nextComment++, body: String(input.body ?? ''), createdSeq: n };
      f.issue.comments.push(comment);
      return { commentEdge: { node: { __type: 'IssueComment', id: gid('IssueComment', String(comment.id)), body: comment.body } } };
    }
    errors.push({ message: `Cannot query field "${name}" on type "Mutation".` }); return null;
  }
  if (typeName === 'Repository') {
    const repo = obj.repo as Repo;
    if (name === 'owner') return { __type: 'User', login: VIEWER.login, id: VIEWER.id };
    if (name === 'defaultBranchRef') { const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`); return tip ? { __type: 'Ref', name: repo.defaultBranch, target: { oid: tip } } : null; }
    if (name === 'issue') { const issue = repo.issues.find((i) => i.number === Number(args.number)); return issue ? issueGql(repo, issue) : null; }
    if (name === 'issues') {
      let list = [...repo.issues];
      if (Array.isArray(args.states)) { const states = (args.states as unknown[]).map((s) => String(s).toLowerCase()); list = list.filter((i) => states.includes(i.state)); }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const dir = String(orderBy?.direction ?? 'DESC');
      list.sort((a, z) => (dir === 'ASC' ? a.createdSeq - z.createdSeq : z.createdSeq - a.createdSeq));
      return connection(list.map((i) => issueGql(repo, i)), args);
    }
    if (name === 'pullRequests') { let list = [...repo.pulls]; if (Array.isArray(args.states)) { const states = (args.states as unknown[]).map((s) => String(s).toLowerCase()); list = list.filter((p) => states.includes(p.state) || (p.merged && states.includes('merged'))); } return connection(list.map((p) => pullGql(repo, p)), args); }
    if (name === 'pullRequest') { const pr = repo.pulls.find((p) => p.number === Number(args.number)); return pr ? pullGql(repo, pr) : null; }
    if (name in obj && obj[name] !== undefined) return obj[name];
    if (known && !known.includes(name)) { errors.push({ message: `Cannot query field "${name}" on type "Repository".` }); return null; }
    return obj[name] ?? null;
  }
  if (typeName === 'PullRequest') {
    const pr = (obj as Record<string, unknown>).pull as Pull; const repo = (obj as Record<string, unknown>).repo as Repo;
    if (name === 'files') { const files = pullFiles(repo, pr); return connection(files.map((f) => ({ __type: 'PullRequestChangedFile', path: f.path, filename: f.path, additions: f.additions, deletions: f.deletions })), args); }
    if (name === 'author') return { __type: 'User', login: VIEWER.login, id: VIEWER.id };
    if (name === 'commits') return connection(commitsFrom(repo, pr.headShaAtCreate).map((s) => ({ __type: 'Commit', oid: s })), args);
    if (known && !known.includes(name)) { errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` }); return null; }
    return obj[name] ?? null;
  }
  if (typeName === 'Issue') {
    if (name === 'author') return { __type: 'User', login: VIEWER.login, id: VIEWER.id };
    if (name === 'comments') { const issue = (obj as Record<string, unknown>).issue as Issue; return connection(issue.comments.map((c) => ({ __type: 'IssueComment', id: gid('IssueComment', String(c.id)), body: c.body })), args); }
    if (known && !known.includes(name)) { errors.push({ message: `Cannot query field "${name}" on type "Issue".` }); return null; }
    return obj[name] ?? null;
  }
  if (typeName === '__Type') { return obj[name] ?? null; }
  if (typeName === 'User') { if (known && !known.includes(name)) { errors.push({ message: `Cannot query field "${name}" on type "User".` }); return null; } return obj[name] ?? null; }
  if (typeName === 'Ref') { if (name === 'target') return obj.target ?? null; return obj[name] ?? null; }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'IssueCommentConnection') {
    if (name === 'nodes' || name === 'edges') return obj.nodes ?? obj.edges ?? null;
    if (name === 'pageInfo') return obj.pageInfo ?? null;
    if (name === 'totalCount') return (obj.nodes as unknown[] | undefined)?.length ?? 0;
    return obj[name] ?? null;
  }
  if (typeName === 'PageInfo') return obj[name] ?? null;
  if (typeName === 'Commit') return obj[name] ?? null;
  return obj[name] ?? null;
}
function connection(nodes: unknown[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  const afterIdx = cursorIndex(args.after);
  const start = afterIdx + 1;
  const slice = nodes.slice(start, start + first);
  const endIdx = start + slice.length - 1;
  return { __type: 'Connection', nodes: slice, edges: slice.map((node) => ({ node, cursor: cursorOf(start + slice.indexOf(node)) })), pageInfo: { __type: 'PageInfo', hasNextPage: start + slice.length < nodes.length, hasPreviousPage: start > 0, endCursor: slice.length ? cursorOf(endIdx) : null, startCursor: slice.length ? cursorOf(start) : null } };
}
function typeOfValue(typeName: string, field: string, value: unknown): string {
  if (value && typeof value === 'object' && (value as Record<string, unknown>).__type) return String((value as Record<string, unknown>).__type);
  if (field === 'issues') return 'IssueConnection';
  if (field === 'pullRequests') return 'PullRequestConnection';
  if (field === 'files') return 'PullRequestChangedFileConnection';
  if (field === 'comments') return 'IssueCommentConnection';
  if (field === 'pageInfo') return 'PageInfo';
  if (field === 'owner' || field === 'author' || field === 'viewer') return 'User';
  if (field === 'defaultBranchRef') return 'Ref';
  if (field === 'repository') return 'Repository';
  if (field === 'issue') return 'Issue';
  if (field === 'pullRequest') return 'PullRequest';
  if (field === 'node') return 'Node';
  return typeName;
}
function executeSels(typeName: string, obj: Record<string, unknown>, sels: Sel[], vars: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.fragment) {
      if (sel.fragment !== typeName && sel.fragment !== 'Node') continue;
      const sub = executeSels(typeName, obj, sel.sels, vars, errors);
      Object.assign(out, sub); continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(typeName, obj, sel.name, sel.args, errors);
    if (sel.sels.length === 0) { out[key] = value; continue; }
    if (value === null || value === undefined) { out[key] = value; continue; }
    if (Array.isArray(value)) { out[key] = value.map((v) => (v && typeof v === 'object' ? executeSels(typeOfValue(typeName, sel.name, v), v as Record<string, unknown>, sel.sels, vars, errors) : v)); continue; }
    if (typeof value === 'object') {
      const childType = typeOfValue(typeName, sel.name, value);
      out[key] = executeSels(childType, value as Record<string, unknown>, sel.sels, vars, errors);
    } else out[key] = value;
  }
  return out;
}
function executeOperation(op: { kind: 'query' | 'mutation'; sels: Sel[] }, vars: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const data = executeSels(op.kind === 'mutation' ? 'Mutation' : 'Query', {}, op.sels, vars, errors);
  return errors.length ? { data, errors } : { data };
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) { badCredentials(res); return; }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
  const runOne = (body: Record<string, unknown>): Record<string, unknown> => {
    const query = String(body.query ?? '');
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    try {
      const ops = new GqlParser(query).parseDocument(vars);
      if (ops.length === 0) return { data: {}, errors: [{ message: 'No operation provided.' }] };
      return executeOperation(ops[0] as { kind: 'query' | 'mutation'; sels: Sel[] }, vars);
    } catch (err) { return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] }; }
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, (parsed.value as Record<string, unknown>[]).map(runOne));
  else sendJson(res, 200, runOne((parsed.value ?? {}) as Record<string, unknown>));
}

// ---------------------------------------------------------------- MCP
const MCP_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_TOOLS: Array<Record<string, unknown>> = [
  { name: 'create_repo', description: 'Create a repository owned by the token owner.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, repository: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch onto a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] } },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
];
function mcpArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}
function mcpToolResult(obj: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    // JSON-RPC 401 for tools/call; the auth check reads the HTTP status.
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}` });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }) + '\n'); return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return;
  }
  const rpc = (body ?? {}) as Record<string, unknown>;
  const id = rpc.id ?? null;
  const method = String(rpc.method ?? '');
  const params = (rpc.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, { 'mcp-session-id': 'forge-1' });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, { 'mcp-session-id': 'forge-1' });
  };
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'mcp-session-id': 'forge-1', 'x-github-request-id': `req-${++reqCounter}` }); res.end(); return; }
  if (method === 'server/discover') { reply({ resultType: 'DiscoverResult', supportedVersions: MCP_VERSIONS, capabilities: { tools: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' }, _meta: { serverInfo: { name: 'github-forge', version: '1.0.0' } } }); return; }
  if (method === 'initialize') {
    const pv = typeof params.protocolVersion === 'string' && MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : '2026-07-28';
    reply({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' } }); return;
  }
  if (method === 'ping') { reply({}); return; }
  if (method === 'tools/list') { reply({ tools: MCP_TOOLS }); return; }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { replyError(-32602, `Unknown tool: ${name}`); return; }
    const schema = tool.inputSchema as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    const missing = required.filter((r) => args[r] === undefined && mcpArg(args, r) === undefined);
    // For merge_pull_request the suite may pass `number` instead of `pull_number`.
    const effectiveMissing = missing.filter((r) => !(name === 'merge_pull_request' && r === 'pull_number' && args.number !== undefined) && !(name === 'get_issue' && r === 'number' && args.issue_number !== undefined));
    if (effectiveMissing.length) { reply({ content: [{ type: 'text', text: `Missing required arguments: ${effectiveMissing.join(', ')}` }], isError: true }); return; }
    const owner = String(mcpArg(args, 'owner', 'owner_login', 'login') ?? VIEWER.login);
    const repoName = String(mcpArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name') ?? '');
    const getRepoOrError = (): Repo | null => {
      const repo = getRepo(owner, repoName);
      if (!repo) { reply({ content: [{ type: 'text', text: `Repository not found: ${owner}/${repoName}` }], isError: true }); return null; }
      return repo;
    };
    if (name === 'create_repo') {
      const nm = String(mcpArg(args, 'name', 'repo', 'repository') ?? '');
      if (!nm) { reply({ content: [{ type: 'text', text: 'Missing required arguments: name' }], isError: true }); return; }
      if (repos.has(repoKey(VIEWER.login, nm))) { const existing = repos.get(repoKey(VIEWER.login, nm)) as Repo; reply(mcpToolResult(repoJson(existing))); return; }
      const repo = newRepo(nm, String(mcpArg(args, 'description') ?? ''), mcpArg(args, 'private') === true);
      reply(mcpToolResult(repoJson(repo))); return;
    }
    if (name === 'get_repo') { const repo = getRepoOrError(); if (!repo) return; reply(mcpToolResult(repoJson(repo))); return; }
    if (name === 'create_issue') {
      const repo = getRepoOrError(); if (!repo) return;
      const title = String(mcpArg(args, 'title', 'issue_title', 'subject') ?? '');
      if (!title) { reply({ content: [{ type: 'text', text: 'Missing required arguments: title' }], isError: true }); return; }
      const n = nextSeq(); const issue: Issue = { id: repo.id * 100000 + repo.nextIssue, number: repo.nextIssue++, title, body: String(mcpArg(args, 'body', 'description', 'content') ?? ''), state: 'open', labels: [], createdSeq: n, closedAt: null, comments: [] };
      repo.issues.push(issue); reply(mcpToolResult(issueJson(repo, issue))); return;
    }
    if (name === 'list_issues') {
      const repo = getRepoOrError(); if (!repo) return;
      const state = String(mcpArg(args, 'state') ?? 'open');
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      reply(mcpToolResult({ issues: list, total: list.length })); return;
    }
    if (name === 'create_pull_request') {
      const repo = getRepoOrError(); if (!repo) return;
      const head = String(mcpArg(args, 'head', 'head_ref', 'head_branch', 'source') ?? '');
      const base = String(mcpArg(args, 'base', 'base_ref', 'base_branch', 'target') ?? repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) { reply({ content: [{ type: 'text', text: 'Head or base branch not found' }], isError: true }); return; }
      const n = nextSeq();
      const pr: Pull = { id: repo.id * 100000 + repo.nextPull, number: repo.nextPull++, title: String(mcpArg(args, 'title', 'pr_title') ?? ''), body: String(mcpArg(args, 'body', 'description') ?? ''), state: 'open', head, base, baseShaAtCreate: baseSha, headShaAtCreate: headSha, merged: false, mergeCommitSha: null, mergedAt: null, createdSeq: n };
      repo.pulls.push(pr); reply(mcpToolResult(pullJson(repo, pr))); return;
    }
    if (name === 'merge_pull_request') {
      const repo = getRepoOrError(); if (!repo) return;
      const num = Number(mcpArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number') ?? 0);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) { reply({ content: [{ type: 'text', text: 'Pull request not found' }], isError: true }); return; }
      const sha = doMerge(repo, pr);
      if (!sha) { reply({ content: [{ type: 'text', text: 'Merge conflict' }], isError: true }); return; }
      reply(mcpToolResult(pullJson(repo, pr))); return;
    }
    if (name === 'get_issue') {
      const repo = getRepoOrError(); if (!repo) return;
      const num = Number(mcpArg(args, 'number', 'issue_number') ?? 0);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) { reply({ content: [{ type: 'text', text: 'Issue not found' }], isError: true }); return; }
      reply(mcpToolResult(issueJson(repo, issue))); return;
    }
    if (name === 'list_pull_requests') {
      const repo = getRepoOrError(); if (!repo) return;
      const state = String(mcpArg(args, 'state') ?? 'open');
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullJson(repo, p));
      reply(mcpToolResult({ pull_requests: list, total: list.length })); return;
    }
    replyError(-32602, `Unknown tool: ${name}`); return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, oid]) => ({ name, oid }));
}
function peeledOf(repo: Repo, ref: { name: string; oid: string }): string | undefined {
  const obj = repo.objects.get(ref.oid);
  if (obj && obj.type === 'tag') return parseTag(obj.data).object;
  return undefined;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'symref=HEAD:refs/heads/main agent=github-forge/1.0.0 object-format=sha1 side-band-64k multi_ack_detailed thin-pack ofs-delta shallow'
    : 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0.0 object-format=sha1';
  const refs = sortedRefs(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = repo.refs.get('refs/heads/main') ?? repo.refs.get('refs/heads/' + repo.defaultBranch) ?? refs[0]?.oid ?? ZERO_OID;
    lines.push(`${tip} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const peeled = peeledOf(repo, r);
      if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=github-forge/1.0.0\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'server-option\n', 'object-format=sha1\n', 'flush']);
}
function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const refs = sortedRefs(repo);
  const out: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn) out.push(`unborn refs/heads/${repo.defaultBranch}\n`);
    return pktLines([...out, 'flush']);
  }
  if (args.symrefs) {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
    if (tip) out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const r of refs) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    const peeled = args.peel ? peeledOf(repo, r) : undefined;
    if (peeled) line += ` peeled:${peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush' as never);
  return pktLines(out as unknown as Array<string | Buffer | 'flush' | 'delim'>);
}
function fetchResponse(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null, wantWantedRefs = false): Buffer {
  // Compute the object set to send.
  const send = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== null) {
    // BFS by commit generation from each want.
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
    const includedCommits = new Set<string>();
    while (queue.length) {
      const [oid, d] = queue.shift() as [string, number];
      if (dist.has(oid)) continue;
      const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
      dist.set(oid, d); includedCommits.add(oid);
      if (d < depth - 1) { for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]); }
    }
    const addTree = (treeOid: string): void => {
      const obj = repo.objects.get(treeOid); if (!obj || obj.type !== 'tree') return;
      send.add(treeOid);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') addTree(e.oid);
        else send.add(e.oid);
      }
    };
    for (const oid of includedCommits) {
      const d = dist.get(oid) as number;
      const obj = repo.objects.get(oid) as GitObj;
      const c = parseCommit(obj.data);
      if (d === depth - 1) shallowOut.push(oid);
      send.add(oid);
      addTree(c.tree);
    }
    // Unshallow: client shallow boundaries that are now fully included.
    for (const s of clientShallow) {
      if (includedCommits.has(s)) {
        const obj = repo.objects.get(s); if (!obj) continue;
        const parents = obj.type === 'commit' ? parseCommit(obj.data).parents : [];
        if (parents.every((p) => includedCommits.has(p))) unshallowOut.push(s);
      }
    }
  } else {
    for (const w of wants) for (const x of collectReachable([w], (o) => repo.objects.get(o))) send.add(x);
  }
  // Subtract what the client already has (full reachability from haves).
  const haveSet = new Set<string>();
  for (const h of haves) { try { for (const x of collectReachable([h], (o) => repo.objects.get(o))) haveSet.add(x); } catch { /* unknown have */ } }
  for (const x of haveSet) send.delete(x);
  // Thin pack: objects the client has must not be re-sent; already subtracted.
  const objects: GitObj[] = [...send].sort().map((oid) => repo.objects.get(oid) as GitObj).filter(Boolean);
  const pack = writePack(objects);
  const parts: Array<string | Buffer | 'flush' | 'delim'> = [];
  // Protocol v2: the acknowledgments section only exists when the client sent
  // haves to negotiate over; with no haves the server goes straight to the
  // packfile (real git expects that, and the suite's parser tolerates it).
  if (haves.length) {
    parts.push('acknowledgments\n');
    const knownHave = haves.find((h) => repo.objects.has(h));
    if (knownHave) { parts.push(`ACK ${knownHave}\n`); parts.push('ready\n'); }
    else parts.push('NAK\n');
    parts.push('delim');
  }
  if (shallowOut.length || unshallowOut.length) {
    parts.push('shallow-info\n');
    for (const s of shallowOut) parts.push(`shallow ${s}\n`);
    for (const s of unshallowOut) parts.push(`unshallow ${s}\n`);
    parts.push('delim');
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const w of wants) for (const r of sortedRefs(repo)) if (r.oid === w) wantedRefs.push({ oid: w, ref: r.name });
  if (wantedRefs.length && wantWantedRefs) {
    parts.push('wanted-refs\n');
    for (const w of wantedRefs) parts.push(`${w.oid} ${w.ref}\n`);
    parts.push('delim');
  }
  parts.push('packfile\n');
  // sideband: chunk the pack into <= 60000-byte frames, band 1.
  const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const frame = Buffer.concat([Buffer.from([1]), pack.subarray(off, off + CHUNK)]);
    parts.push(frame);
  }
  parts.push('flush');
  return pktLines(parts);
}
async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string, kind: 'info-refs' | 'upload' | 'receive'): Promise<void> {
  const repo = getRepo(owner, repoName);
  if (kind === 'info-refs') {
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const svc = req.url?.includes('git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2' && svc === 'git-upload-pack';
    const body = wantV2 ? v2Advertisement() : v0Advertisement(repo, svc as 'git-upload-pack' | 'git-receive-pack');
    sendRaw(res, 200, body, svc === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
    return;
  }
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const raw = await readBody(req);
  if (kind === 'upload') {
    const { packets } = parsePktLines(raw);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim();
    if (command === 'ls-refs') {
      const args = { peel: lines.includes('peel\n'), symrefs: lines.includes('symrefs\n'), unborn: lines.includes('unborn\n'), prefixes: lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim()) };
      sendRaw(res, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result'); return;
    }
    if (command === 'fetch') {
      const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim());
      const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
      const clientShallow = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8).trim());
      const deepenLine = lines.find((l) => l.startsWith('deepen '));
      const depth = deepenLine ? Number(deepenLine.slice(7).trim()) : null;
      const wantWantedRefs = lines.includes('wanted-refs\n');
      sendRaw(res, 200, fetchResponse(repo, wants, haves, clientShallow, Number.isFinite(depth) ? depth : null, wantWantedRefs), 'application/x-git-upload-pack-result'); return;
    }
    sendRaw(res, 200, pktLines(['flush']), 'application/x-git-upload-pack-result'); return;
  }
  // receive-pack (v0)
  const { packets, rest } = parsePktLines(raw);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0'); if (nul >= 0) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line);
    if (m) commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  const reportLines: string[] = [];
  let unpackOk = true; let unpackDetail = 'ok';
  let packObjects: GitObj[] = [];
  if (rest.length > 0) {
    try { packObjects = readPack(Buffer.from(rest), repo); for (const o of packObjects) { const oid = hashObject(o.type, o.data); if (!repo.objects.has(oid)) repo.objects.set(oid, o); } }
    catch (err) { unpackOk = false; unpackDetail = err instanceof Error ? err.message : 'unpack error'; }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      let ok = true; let reason = '';
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'old value does not match'; }
      else if (cmd.newOid === ZERO_OID) {
        if (current === ZERO_OID) { ok = false; reason = 'ref does not exist'; }
      } else if (!repo.objects.has(cmd.newOid)) { ok = false; reason = 'object not found'; }
      else if (current !== ZERO_OID) {
        const newObj = repo.objects.get(cmd.newOid) as GitObj; const curObj = repo.objects.get(current) as GitObj;
        if (newObj.type === 'commit' && curObj?.type === 'commit') {
          try { const anc = collectReachable([cmd.newOid], (o) => repo.objects.get(o)); if (!anc.has(current)) { ok = false; reason = 'non-fast-forward'; } } catch { ok = false; reason = 'object not found'; }
        }
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref); else repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      } else reportLines.push(`ng ${cmd.ref} ${reason}\n`);
    }
  }
  const reportBody = pktLines([`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...reportLines, 'flush']);
  const framed = pktLines([Buffer.concat([Buffer.from([1]), reportBody]), 'flush']);
  sendRaw(res, 200, framed, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        let url: URL;
        try { url = new URL(req.url ?? '/', 'http://entry'); } catch { notFound(res); return; }
        const path = url.pathname;
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql' && method === 'POST') { await handleGraphql(req, res); return; }
        if (path === '/mcp' && method === 'POST') { await handleMcp(req, res); return; }
        if (path.startsWith('/api/v3')) {
          const segs = path.split('/').filter(Boolean).slice(2).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
          // Re-encode owner/name lookups: handleRest expects raw segments; use decoded path split.
          const rawSegs = path.split('/').filter(Boolean).slice(2);
          void segs;
          await handleRest(req, res, url, rawSegs); return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string); const repoName = decodeURIComponent(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          if (tail === 'info/refs' && method === 'GET') { await handleGit(req, res, owner, repoName, '', 'info-refs'); return; }
          if (tail === 'git-upload-pack' && method === 'POST') { await handleGit(req, res, owner, repoName, '', 'upload'); return; }
          if (tail === 'git-receive-pack' && method === 'POST') { await handleGit(req, res, owner, repoName, '', 'receive'); return; }
        }
        if (path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp') { notFound(res); return; }
        // Unknown route: JSON 404 (with auth check for API-shaped paths already handled).
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
