/**
 * Map module — the Ist extractor (`docs/map-model-schema.md`, PROC-SPEC-002).
 *
 * Reads a checked-out repository and produces the renderer-neutral model of §3:
 * `model.json` (levels 1+2) plus `processes/<id>.json` (level 3). Deterministic,
 * offline, zero LLM, no network. Naming that the code does not carry comes from
 * the meaning layer (§4); everything the meaning layer does not answer is
 * reported in `unmapped` — extraction still succeeds, the gate (`map check`)
 * decides later.
 *
 * This module is pure library: it reads the repo and returns data. Writing the
 * model files is `writeModel`, printing is the command's business — src/ may not
 * touch stdout (spec §3).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Compose services that are a data store rather than an app process.
const STORE_IMAGE = /postgres|pgvector|mysql|mariadb|mongo|garage|minio|redis|valkey/i;
// Which compose service is "the app" — the endpoint of adapter and webhook edges.
const APP_SERVICE_ORDER = ["web", "app", "server", "api"];
// Directories that may hold mode-switched adapters, in order of preference.
const ADAPTER_DIRS = ["server/src/adapters", "src/adapters"];
// Directories that may hold SQL migrations, in order of preference.
const MIGRATION_DIRS = [
  "server/src/data/migrations",
  "server/migrations",
  "db/migrations",
  "migrations",
];
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml"];
// An inbound route is one whose path names a webhook or an inbound entrypoint.
// `hook` rather than `webhook`: the cockpit's signed n8n callbacks land on
// /api/hooks/n8n/:stage, and those are inbound webhooks by every other measure.
const INBOUND_PATH = /hooks?|inbound/i;
// A route declaration, tolerant of the path sitting on the next line.
const ROUTE_DECL = /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
// The leading code/if chain that guards a flow — collapsed into one `check` step.
const CHECK_NODE = /sign|verif|valid|hmac|auth|check|guard/i;
// A step that ends a flow badly.
const ERROR_NODE = /fail|error|reject|invalid|unauthor|forbidden|denied/i;

// --- the shapes of §3 and §4 ---------------------------------------------

/** Evidence for a node, an edge or a trigger: file, line, short label (§3.1). */
export interface Source {
  path: string;
  line: number;
  label: string;
}

export interface ModelNode {
  id: string;
  level: 1 | 2 | 3;
  parent?: string;
  kind: "app" | "service" | "store" | "module" | "external" | "process";
  type: string;
  label: string;
  sublabel?: string;
  sources: Source[];
}

export interface ModelEdge {
  from: string;
  to: string;
  kind: "depends" | "calls" | "webhook";
  direction: "in" | "out";
  sources: Source[];
}

export interface ProcessStep {
  id: string;
  lane: string;
  kind: "trigger" | "check" | "call" | "callback" | "error";
  label: string;
  /** The raw key of a call target, before the meaning layer resolved it. */
  raw?: string;
}

export interface ProcessEdge {
  from: string;
  to: string;
  role: "main" | "error" | "return";
}

export interface MapProcess {
  schema_version: 1;
  id: string;
  label: string;
  parent: string;
  trigger: {
    kind: "webhook" | "schedule";
    from?: string;
    path?: string;
    sources: Source[];
  };
  lanes: string[];
  steps: ProcessStep[];
  edges: ProcessEdge[];
  return?: { to: string; kind: string };
}

/** The meaning layer of §4 — the only file a human edits. */
export interface Meaning {
  schema_version?: number;
  project?: {
    id?: string;
    label?: string;
    sublabel?: string;
    modulesRoot?: string | null;
  };
  /** raw key -> node id; `null` marks a key that is deliberately not a node (e.g. a UI route the pattern caught). */
  raw?: Record<string, string | null>;
  nodes?: Record<string, { label?: string; sublabel?: string; type?: string }>;
}

export interface Model {
  schema_version: 1;
  project: string;
  repo: { url: string | null; revision: string | null };
  extracted_at: string;
  extractors: Record<string, number>;
  nodes: ModelNode[];
  edges: ModelEdge[];
  counts: Record<string, number>;
}

export interface Unmapped {
  raw: string[];
  nodes: string[];
}

export interface ExtractResult {
  model: Model;
  processes: MapProcess[];
  unmapped: Unmapped;
  /** Compose networks — §3.1 has no field for them, they are reported only. */
  networks: string[];
  composeFile: string | null;
}

// --- small helpers -------------------------------------------------------

const readIf = (repo: string, rel: string): string | null => {
  const abs = path.join(repo, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
};

const listIf = (repo: string, rel: string): string[] => {
  const abs = path.join(repo, rel);
  return fs.existsSync(abs) ? fs.readdirSync(abs).sort() : [];
};

/** Directory entries of `rel`, sorted by name; `null` when the directory is absent. */
const entriesIf = (repo: string, rel: string): DirEntry[] | null => {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
};

const firstDir = (repo: string, candidates: string[]): string | undefined =>
  candidates.find((d) => fs.existsSync(path.join(repo, d)));

/** 1-based line number of the first match, or 1 when there is none. */
const lineOf = (text: string, re: RegExp): number => {
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : 1;
};

const unquote = (s: string): string =>
  s
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();

/** `pg${POSTGRES_MAJOR:?long error message}` -> `pg$POSTGRES_MAJOR`, `${TAG:-latest}` -> `latest`. */
const resolveEnvRefs = (s: string): string =>
  s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?[^}]*\}/g,
    (_, name: string, fallback?: string) => (fallback !== undefined ? fallback : `$${name}`),
  );

/** `[a, b]` -> ["a","b"]; anything else -> null. */
const inlineList = (s: string): string[] | null => {
  const m = /^\[(.*)\]$/.exec(s.trim());
  if (!m) return null;
  return (m[1] as string).split(",").map(unquote).filter(Boolean);
};

// --- compose -------------------------------------------------------------

export interface ComposeService {
  name: string;
  line: number;
  image: string | null;
  dependsOn: string[];
  networks: string[];
  profiles: string[];
}

type ListField = "dependsOn" | "networks" | "profiles";

/**
 * Indentation scanner for the four compose facts the model needs: service name,
 * image, depends_on, networks, profiles. Deliberately not a YAML parser — the
 * toolkit carries no YAML dependency, and the scanner gives line numbers for
 * free, which the `sources` of §3.1 need anyway. Everything it does not know
 * about (build, labels, healthcheck, volumes) is skipped by indentation.
 */
export function parseCompose(text: string): ComposeService[] {
  const FIELDS = new Map<string, ListField | "image">([
    ["image", "image"],
    ["depends_on", "dependsOn"],
    ["networks", "networks"],
    ["profiles", "profiles"],
  ]);
  const services: ComposeService[] = [];
  let inServices = false;
  let serviceIndent: number | null = null;
  let fieldIndent: number | null = null;
  let itemIndent: number | null = null;
  let cur: ComposeService | null = null;
  let block: ListField | null = null;

  text.split("\n").forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      inServices = /^services:/.test(line);
      cur = null;
      block = null;
      return;
    }
    if (!inServices) return;
    if (serviceIndent === null) serviceIndent = indent;

    if (indent === serviceIndent) {
      const m = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
      cur = m
        ? {
            name: m[1] as string,
            line: i + 1,
            image: null,
            dependsOn: [],
            networks: [],
            profiles: [],
          }
        : null;
      if (cur) services.push(cur);
      block = null;
      return;
    }
    if (!cur) return;

    if (fieldIndent === null && indent > serviceIndent) fieldIndent = indent;
    if (indent === fieldIndent) {
      block = null;
      itemIndent = null;
      const m = /^([A-Za-z0-9._-]+):\s*(.*)$/.exec(line);
      if (!m || !FIELDS.has(m[1] as string)) return;
      const field = FIELDS.get(m[1] as string) as ListField | "image";
      if (field === "image") {
        cur.image = unquote(m[2] as string);
        return;
      }
      const inline = inlineList(m[2] as string);
      if (inline) cur[field].push(...inline);
      else block = field;
      return;
    }
    if (!block || indent <= (fieldIndent as number)) return;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) return; // e.g. `condition: service_healthy` under a map entry

    const item = /^-\s*(.+)$/.exec(line);
    if (item) cur[block].push(unquote(item[1] as string));
    else {
      const key = /^([A-Za-z0-9._-]+):/.exec(line);
      if (key) cur[block].push(key[1] as string);
    }
  });
  return services;
}

/** archify legend type for a compose service. */
function serviceType(name: string, image: string | null): string {
  const s = `${name} ${image || ""}`.toLowerCase();
  if (/postgres|pgvector|mysql|mariadb|mongo/.test(s)) return "database";
  if (/garage|minio|s3/.test(s)) return "cloud";
  if (/redis|valkey|rabbit|nats|kafka|n8n/.test(s)) return "messagebus";
  if (/authelia|keycloak|lldap|traefik|oauth/.test(s)) return "security";
  if (/client|frontend/.test(name)) return "frontend";
  return "backend";
}

// --- modules -------------------------------------------------------------

/** Directory name -> id segment: kebab-case (`oneTimeLinks` -> `one-time-links`). */
export const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** What `moduleNodes` needs of a directory entry — `fs.Dirent` satisfies it. */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

/**
 * The level-2 module nodes of an app (§1, PROC-SPEC-002 rev 5): every directory
 * directly under the project's modules root, which `meaning.json` names in
 * `project.modulesRoot`. Only directories count — a `*.test.ts` at the root of
 * the modules directory is not a module. Without a modules root there are no
 * module nodes, and modules derive no edges in this step.
 */
export function moduleNodes(
  entries: DirEntry[] | null,
  { modulesRoot, appId }: { modulesRoot: string | null | undefined; appId: string },
): ModelNode[] {
  if (!modulesRoot) return [];
  return (entries || [])
    .filter((e) => e.isDirectory())
    .map((e) => ({
      id: `${appId}.${kebab(e.name)}`,
      level: 2 as const,
      parent: appId,
      kind: "module" as const,
      type: "backend",
      label: e.name,
      sources: [{ path: `${modulesRoot}/${e.name}`, line: 1, label: "module directory" }],
    }));
}

// --- n8n -----------------------------------------------------------------

/**
 * Node id of the system an httpRequest URL talks to, as a raw key:
 *   `callback`                  the signed callback to the calling app
 *   `n8n-host:<hostname>`       a literal host in the URL
 *   `n8n-host:env:<VAR>`        the URL is built from an n8n env variable
 *   null                        the URL is built at runtime from earlier data
 * The literal host wins over the env variable: a URL may name both.
 */
export function hostKey(url: string | undefined | null): string | null {
  if (!url) return null;
  if (/callbackUrl/i.test(url)) return "callback";
  const literal = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(url);
  if (literal) return `n8n-host:${literal[1] as string}`;
  const env = /\$env\.([A-Z0-9_]+)/.exec(url);
  if (env) return `n8n-host:env:${env[1] as string}`;
  return null;
}

export interface WorkflowNode {
  name?: string;
  type?: string;
  parameters?: {
    url?: string;
    path?: string;
    responseCode?: number;
    options?: { responseCode?: number };
  };
}

export interface Workflow {
  nodes?: WorkflowNode[];
  connections?: Record<string, { main?: ({ node?: string } | null)[][] }>;
}

const nodeKind = (n: WorkflowNode): string => String(n.type || "").replace(/^n8n-nodes-base\./, "");

const responseCode = (n: WorkflowNode): number =>
  Number(n.parameters?.responseCode ?? n.parameters?.options?.responseCode ?? 200);

const isErrorNode = (n: WorkflowNode): boolean =>
  nodeKind(n) === "stopAndError" ||
  (nodeKind(n) === "respondToWebhook" && responseCode(n) >= 400) ||
  ERROR_NODE.test(n.name || "");

export interface ProcessOptions {
  file: string;
  appNode: string;
  n8nNode?: string;
  resolve: (rawKey: string) => string | null;
}

/**
 * One n8n workflow -> the process of §3.2. `resolve(rawKey)` maps a raw key to a
 * node id (or null when the meaning layer has no entry); `appNode` is the node
 * that calls the flow and receives its callback.
 */
export function extractProcess(
  workflow: Workflow,
  { file, appNode, n8nNode = "n8n", resolve }: ProcessOptions,
): { process: MapProcess; rawKeys: string[] } | null {
  const nodes = (workflow.nodes || []).filter((n) => nodeKind(n) !== "stickyNote");
  const byName = new Map(nodes.map((n) => [n.name as string, n]));
  const stem = path.basename(file).replace(/\.json$/, "");
  const id = `proc.${stem}`;
  const sid = (slug: string): string => `${id}#${slug}`;
  const slug = (name: string): string =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "step";

  const successors = (name: string): string[] =>
    ((workflow.connections || {})[name]?.main || [])
      .flat()
      .map((c) => c?.node)
      .filter((n): n is string => n !== undefined && n !== null && byName.has(n));

  const triggerNode = nodes.find((n) => ["webhook", "scheduleTrigger"].includes(nodeKind(n)));
  if (!triggerNode) return null;

  // Which n8n nodes become steps: the trigger, everything that leaves the n8n
  // lane, and the first guard chain collapsed into one `check`.
  const crossing = new Set(["httpRequest", "respondToWebhook", "stopAndError"]);
  const kept = new Map<string, ProcessStep>(); // n8n node name -> step
  const order: string[] = [];
  const seen = new Set([triggerNode.name as string]);
  const queue: string[] = [triggerNode.name as string];
  let checkTaken = false;

  const triggerLane = nodeKind(triggerNode) === "webhook" ? appNode : n8nNode;
  kept.set(triggerNode.name as string, {
    id: sid("trigger"),
    lane: triggerLane,
    kind: "trigger",
    label: (triggerNode.name || "Trigger").slice(0, 48),
  });
  order.push(triggerNode.name as string);

  while (queue.length) {
    const name = queue.shift() as string;
    for (const next of successors(name)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
      if (kept.has(next)) continue;
      const n = byName.get(next) as WorkflowNode;
      const k = nodeKind(n);
      if (crossing.has(k)) {
        kept.set(next, step(n, k));
        order.push(next);
      } else if (!checkTaken && ["code", "if"].includes(k) && CHECK_NODE.test(n.name || "")) {
        checkTaken = true;
        kept.set(next, {
          id: sid("check"),
          lane: n8nNode,
          kind: "check",
          label: (n.name || "Check").slice(0, 48),
        });
        order.push(next);
      }
    }
  }

  function step(n: WorkflowNode, k: string): ProcessStep {
    if (k !== "httpRequest") {
      return {
        id: sid(slug(n.name as string)),
        lane: n8nNode,
        kind: isErrorNode(n) ? "error" : "callback",
        label: (n.name || k).slice(0, 48),
      };
    }
    const raw = hostKey(n.parameters?.url);
    const target = raw === "callback" ? appNode : raw ? resolve(raw) : null;
    return {
      id: sid(slug(n.name as string)),
      lane: target || n8nNode,
      kind: raw === "callback" ? "callback" : target && target === appNode ? "callback" : "call",
      label: (n.name || "HTTP request").slice(0, 48),
      ...(raw ? { raw } : {}),
    };
  }

  // Edges: walk the n8n graph, skipping every node that did not become a step.
  const edges: ProcessEdge[] = [];
  const emitted = new Set<string>();
  for (const from of order) {
    const reached = new Set<string>();
    const walk = [...successors(from)];
    const visited = new Set<string>();
    while (walk.length) {
      const n = walk.shift() as string;
      if (visited.has(n)) continue;
      visited.add(n);
      if (kept.has(n)) reached.add(n);
      else walk.push(...successors(n));
    }
    for (const to of reached) {
      if (to === from) continue; // an n8n polling loop is not a step transition
      const key = `${from}>${to}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      const target = kept.get(to) as ProcessStep;
      const role: ProcessEdge["role"] =
        target.kind === "error"
          ? "error"
          : target.kind === "callback" && target.lane === appNode
            ? "return"
            : "main";
      edges.push({ from: (kept.get(from) as ProcessStep).id, to: target.id, role });
    }
  }

  const steps = order.map((n) => {
    const s = { ...(kept.get(n) as ProcessStep) };
    delete s.raw;
    return s;
  });
  const lanes: string[] = [];
  for (const s of steps) if (!lanes.includes(s.lane)) lanes.push(s.lane);
  if (!lanes.includes(n8nNode)) lanes.push(n8nNode);

  const callback = steps.find((s) => s.kind === "callback" && s.lane === appNode);
  // `callback` resolves to the calling app without the meaning layer; only the
  // host keys are a question the meaning layer has to answer.
  const rawKeys = order
    .map((n) => (kept.get(n) as ProcessStep).raw)
    .filter((r): r is string => r !== undefined && r !== "callback");

  return {
    process: {
      schema_version: 1,
      id,
      label: stem.replace(/_/g, " "),
      parent: n8nNode,
      trigger: {
        kind: nodeKind(triggerNode) === "webhook" ? "webhook" : "schedule",
        ...(nodeKind(triggerNode) === "webhook" ? { from: appNode } : {}),
        ...(triggerNode.parameters?.path ? { path: String(triggerNode.parameters.path) } : {}),
        sources: [{ path: file, line: 1, label: (triggerNode.name || "trigger").slice(0, 48) }],
      },
      lanes,
      steps,
      edges,
      ...(callback ? { return: { to: appNode, kind: "signed-callback" } } : {}),
    },
    rawKeys,
  };
}

// --- the run -------------------------------------------------------------

function gitFacts(repo: string): { url: string | null; revision: string | null } {
  const git = (...args: string[]): string | null => {
    try {
      // stderr ignored: outside a checkout git writes its own (localised) error,
      // and stderr is the toolkit's progress channel, not git's.
      return execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const url = git("remote", "get-url", "origin");
  return {
    url: url ? url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "") : null,
    revision: git("rev-parse", "HEAD"),
  };
}

export interface ExtractOptions {
  /** Absolute path of the checked-out repository to read. */
  repoRoot: string;
  /** Project name for `model.project` — the meaning layer's `project.id` or `--project`. */
  project: string;
  meaning: Meaning;
}

/**
 * Walks the repo with the six extractors (compose · modules · adapters · routes ·
 * migrations · n8n) and returns the model, the processes and everything the
 * meaning layer left unanswered. Reads the filesystem, writes nothing.
 */
export function extractModel({ repoRoot, project, meaning }: ExtractOptions): ExtractResult {
  const repo = path.resolve(repoRoot);

  const unmappedRaw = new Set<string>();
  const ignoredRaw = new Set<string>();
  const resolve = (rawKey: string): string | null => {
    const id = meaning.raw?.[rawKey];
    if (id === undefined) {
      unmappedRaw.add(rawKey);
      return null;
    }
    if (id === null || id === "") {
      ignoredRaw.add(rawKey);
      return null;
    }
    return id;
  };

  const appId = meaning.project?.id || project;
  if (!meaning.project?.id) unmappedRaw.add(`project:${project}`);

  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  const counts: Record<string, number> = {};
  const extractors: Record<string, number> = {};
  const push = (n: ModelNode): void => {
    if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
  };
  /** Display facts of an external node, as far as the meaning layer names them. */
  const external = (id: string, sources: Source[]): ModelNode => {
    const facts = meaning.nodes?.[id];
    return {
      id,
      level: 1,
      kind: "external",
      type: facts?.type || "external",
      label: facts?.label || id,
      ...(facts?.sublabel ? { sublabel: facts.sublabel } : {}),
      sources,
    };
  };

  // --- compose
  const composeFile = COMPOSE_FILES.find((f) => fs.existsSync(path.join(repo, f))) ?? null;
  let services: ComposeService[] = [];
  if (composeFile) {
    extractors.compose = 1;
    services = parseCompose(fs.readFileSync(path.join(repo, composeFile), "utf8"));
    push({
      id: appId,
      level: 1,
      kind: "app",
      type: "backend",
      label: meaning.project?.label || project,
      ...(meaning.project?.sublabel ? { sublabel: meaning.project.sublabel } : {}),
      sources: [{ path: composeFile, line: 1, label: "compose stack" }],
    });
    for (const s of services) {
      const store = STORE_IMAGE.test(s.image || "");
      push({
        id: s.name,
        level: 2,
        parent: appId,
        kind: store ? "store" : "service",
        type: serviceType(s.name, s.image),
        label: s.name,
        sublabel: [
          s.image ? resolveEnvRefs(s.image) : "build",
          s.profiles.length ? `profile ${s.profiles.join(",")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        sources: [{ path: composeFile, line: s.line, label: "compose service" }],
      });
    }
    for (const s of services)
      for (const d of s.dependsOn)
        if (services.some((x) => x.name === d))
          edges.push({
            from: s.name,
            to: d,
            kind: "depends",
            direction: "out",
            sources: [{ path: composeFile, line: s.line, label: "depends_on" }],
          });
    counts.services = services.length;
  }

  const appNode =
    APP_SERVICE_ORDER.find((n) => services.some((s) => s.name === n)) ||
    services.find((s) => !STORE_IMAGE.test(s.image || ""))?.name ||
    appId;

  // --- modules
  const modulesRoot = meaning.project?.modulesRoot || null;
  const moduleEntries = modulesRoot ? entriesIf(repo, modulesRoot) : null;
  if (moduleEntries) {
    extractors.modules = 1;
    const mods = moduleNodes(moduleEntries, { modulesRoot, appId });
    for (const m of mods) push(m);
    counts.modules = mods.length;
  }

  // --- adapters
  const adapterDir = firstDir(repo, ADAPTER_DIRS);
  if (adapterDir) {
    extractors.adapters = 1;
    const files = listIf(repo, adapterDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    let found = 0;
    for (const f of files) {
      const rel = `${adapterDir}/${f}`;
      const text = fs.readFileSync(path.join(repo, rel), "utf8");
      if (!/\b[A-Z][A-Z0-9_]*_MODE\b/.test(text)) continue;
      found += 1;
      const name = f.replace(/\.ts$/, "");
      const target = resolve(`adapter:${name}`);
      if (!target) continue;
      push(external(target, []));
      const node = nodes.find((n) => n.id === target) as ModelNode;
      if (node.sources.length < 3)
        node.sources.push({
          path: rel,
          line: lineOf(text, /\b[A-Z][A-Z0-9_]*_MODE\b/),
          label: `${name} adapter`.slice(0, 48),
        });
      edges.push({
        from: appNode,
        to: target,
        kind: "calls",
        direction: "out",
        sources: [
          { path: rel, line: lineOf(text, /\b[A-Z][A-Z0-9_]*_MODE\b/), label: `${name} adapter` },
        ],
      });
    }
    counts.adapters = found;
  }

  // --- routes
  const appTs = readIf(repo, "server/src/app.ts") ? "server/src/app.ts" : null;
  if (appTs) {
    extractors.routes = 1;
    const text = readIf(repo, appTs) as string;
    // Both repos mount routers with `app.use(...)`, but one passes the router
    // (`app.use(fooRouter)`) and the other a factory (`app.use(createFooRouter({…}))`),
    // so the mount is counted by the statement, not by one call shape.
    counts.routers = text
      .split("app.use(")
      .slice(1)
      .filter((chunk) => /Router/.test(chunk.split(";\n")[0] as string)).length;

    const routeFiles = [
      appTs,
      ...listIf(repo, "server/src/routes")
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `server/src/routes/${f}`),
    ];
    let inbound = 0;
    for (const rel of routeFiles) {
      const body = readIf(repo, rel);
      if (!body) continue;
      for (const m of body.matchAll(ROUTE_DECL)) {
        if (!INBOUND_PATH.test(m[2] as string)) continue;
        inbound += 1;
        const line = body.slice(0, m.index).split("\n").length;
        const rawKey = `route:${(m[1] as string).toUpperCase()} ${m[2] as string}`;
        const from = resolve(rawKey);
        if (!from) continue;
        push(external(from, []));
        edges.push({
          from,
          to: appNode,
          kind: "webhook",
          direction: "in",
          sources: [{ path: rel, line, label: (m[2] as string).slice(0, 48) }],
        });
      }
    }
    counts.inbound_routes = inbound;
  }

  // --- migrations
  const migrationDir = firstDir(repo, MIGRATION_DIRS);
  if (migrationDir) {
    extractors.migrations = 1;
    counts.migrations = listIf(repo, migrationDir).filter((f) => f.endsWith(".sql")).length;
  }

  // --- n8n
  const workflowDir = "n8n/workflows";
  const processes: MapProcess[] = [];
  if (fs.existsSync(path.join(repo, workflowDir))) {
    extractors.n8n = 1;
    const n8nNode = services.some((s) => s.name === "n8n")
      ? "n8n"
      : resolve("adapter:n8n") || "n8n";
    for (const f of listIf(repo, workflowDir).filter((name) => name.endsWith(".json"))) {
      const rel = `${workflowDir}/${f}`;
      let workflow: Workflow;
      try {
        workflow = JSON.parse(fs.readFileSync(path.join(repo, rel), "utf8")) as Workflow;
      } catch {
        continue;
      }
      const result = extractProcess(workflow, { file: rel, appNode, n8nNode, resolve });
      if (!result) continue;
      processes.push(result.process);
      push({
        id: result.process.id,
        level: 3,
        parent: n8nNode,
        kind: "process",
        type: "messagebus",
        label: result.process.label,
        sources: [{ path: rel, line: 1, label: "n8n workflow" }],
      });
      // Lanes that the meaning layer named become landscape nodes and edges.
      for (const lane of result.process.lanes) {
        if (lane === appNode || lane === n8nNode) continue;
        push(external(lane, [{ path: rel, line: 1, label: "n8n workflow" }]));
        if (!edges.some((e) => e.from === n8nNode && e.to === lane && e.kind === "calls"))
          edges.push({
            from: n8nNode,
            to: lane,
            kind: "calls",
            direction: "out",
            sources: [{ path: rel, line: 1, label: result.process.label.slice(0, 48) }],
          });
      }
    }
    counts.processes = processes.length;
  }

  const model: Model = {
    schema_version: 1,
    project,
    repo: gitFacts(repo),
    extracted_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    extractors,
    nodes: nodes.map((n) => ({ ...n, sources: (n.sources || []).slice(0, 3) })),
    edges: edges.map((e) => ({ ...e, sources: (e.sources || []).slice(0, 3) })),
    counts,
  };

  // Every node id that no extractor could name needs display facts (§4).
  if (ignoredRaw.size) counts.ignored = ignoredRaw.size;
  const unmappedNodes = model.nodes
    .filter((n) => n.kind === "external" && !meaning.nodes?.[n.id])
    .map((n) => n.id);

  return {
    model,
    processes,
    unmapped: { raw: [...unmappedRaw].sort(), nodes: [...new Set(unmappedNodes)].sort() },
    networks: [...new Set(services.flatMap((s) => s.networks))],
    composeFile,
  };
}

/**
 * Writes the four model files of §3 into `out`, creating it if needed. The
 * meaning layer is copied alongside the model — unless the source it was read
 * from already *is* that file, which would rewrite the one file a human edits.
 */
export function writeModel(
  out: string,
  result: ExtractResult,
  meaning: Meaning,
  meaningSource?: string,
): void {
  const dir = path.resolve(out);
  fs.mkdirSync(path.join(dir, "processes"), { recursive: true });
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  const copy = path.join(dir, "meaning.json");
  if (meaningSource === undefined || path.resolve(meaningSource) !== copy)
    fs.writeFileSync(copy, json(meaning));
  fs.writeFileSync(path.join(dir, "model.json"), json(result.model));
  for (const p of result.processes)
    fs.writeFileSync(path.join(dir, "processes", `${p.id}.json`), json(p));
  fs.writeFileSync(path.join(dir, "unmapped.json"), json(result.unmapped));
}
