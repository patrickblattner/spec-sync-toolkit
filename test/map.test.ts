import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { MAP_OUT, runMap } from "../src/commands/map.js";
import {
  extractProcess,
  hostKey,
  kebab,
  moduleNodes,
  parseCompose,
  type Meaning,
  type Workflow,
} from "../src/map/extract.js";
import { EXIT } from "../src/output.js";

describe("parseCompose", () => {
  it("reads depends_on as a list and as a map, plus image, networks and profiles", () => {
    const services = parseCompose(`# leading comment
name: demo
services:
  web:
    image: node:22
    networks:
      - internal
      - traefik
    depends_on:
      postgres:
        condition: service_healthy
      garage:
        condition: service_started
    labels:
      - "traefik.http.routers.web.rule=Host(\`x\`)"
  worker:
    build:
      context: .
      dockerfile: infra/worker.Dockerfile
    profiles: [batch]
    depends_on:
      - postgres
  postgres:
    image: pgvector/pgvector:pg17
    networks: [internal]

networks:
  internal: {}
`);
    expect(services.map((s) => s.name)).toEqual(["web", "worker", "postgres"]);
    const [web, worker, postgres] = services;
    expect(web?.image).toBe("node:22");
    expect(web?.networks).toEqual(["internal", "traefik"]);
    expect(web?.dependsOn).toEqual(["postgres", "garage"]);
    expect(worker?.image).toBeNull();
    expect(worker?.dependsOn).toEqual(["postgres"]);
    expect(worker?.profiles).toEqual(["batch"]);
    expect(postgres?.networks).toEqual(["internal"]);
    expect(web?.line).toBe(4);
  });

  it("does not read the top-level networks block as services", () => {
    const services = parseCompose("services:\n  web:\n    image: a\n\nnetworks:\n  traefik:\n");
    expect(services.map((s) => s.name)).toEqual(["web"]);
  });
});

describe("hostKey", () => {
  it("names the signed callback, literal hosts and env-built URLs", () => {
    expect(hostKey("={{ $json.callbackUrl }}")).toBe("callback");
    expect(hostKey("https://api.heygen.com/v3/videos")).toBe("n8n-host:api.heygen.com");
    expect(hostKey("=https://graph.facebook.com/v21.0/{{ $env.IG_USER_ID }}/media")).toBe(
      "n8n-host:graph.facebook.com",
    );
    expect(hostKey("={{ $env.COMMUNITY_BASE_URL + '/api/inbound/campaign-status' }}")).toBe(
      "n8n-host:env:COMMUNITY_BASE_URL",
    );
    expect(hostKey("={{ $json.videoUrl }}")).toBeNull();
    expect(hostKey(undefined)).toBeNull();
  });
});

describe("kebab / moduleNodes", () => {
  const dir = (name: string) => ({ name, isDirectory: () => true });
  const file = (name: string) => ({ name, isDirectory: () => false });
  const opts = { modulesRoot: "server/src/domain", appId: "community" };

  it("kebab-cases the directory name for the id and keeps it as-is for the label", () => {
    expect(kebab("oneTimeLinks")).toBe("one-time-links");
    const mods = moduleNodes(
      [dir("assets"), dir("eventOrg"), dir("oneTimeLinks"), dir("cueCards")],
      opts,
    );
    expect(mods.map((m) => m.id)).toEqual([
      "community.assets",
      "community.event-org",
      "community.one-time-links",
      "community.cue-cards",
    ]);
    expect(mods.map((m) => m.label)).toEqual(["assets", "eventOrg", "oneTimeLinks", "cueCards"]);
  });

  it("makes a level-2 module node parented on the app, with the directory as its source", () => {
    expect(moduleNodes([dir("eventOrg")], opts)[0]).toEqual({
      id: "community.event-org",
      level: 2,
      parent: "community",
      kind: "module",
      type: "backend",
      label: "eventOrg",
      sources: [{ path: "server/src/domain/eventOrg", line: 1, label: "module directory" }],
    });
  });

  it("counts directories only — a file at the modules root is not a module", () => {
    const mods = moduleNodes(
      [dir("costs"), file("concurrencyClaims.test.ts"), file("index.ts")],
      opts,
    );
    expect(mods.map((m) => m.id)).toEqual(["community.costs"]);
  });

  it("emits nothing for a project whose meaning layer names no modules root", () => {
    expect(moduleNodes([dir("costs")], { modulesRoot: null, appId: "community" })).toEqual([]);
  });
});

// webhook -> code -> if -> httpRequest -> code -> httpRequest(callback)
const fixture: Workflow = {
  nodes: [
    { name: "Webhook trigger", type: "n8n-nodes-base.webhook", parameters: { path: "demo" } },
    { name: "Verify signature", type: "n8n-nodes-base.code", parameters: {} },
    { name: "Signature valid?", type: "n8n-nodes-base.if", parameters: {} },
    {
      name: "HeyGen render",
      type: "n8n-nodes-base.httpRequest",
      parameters: { url: "https://api.heygen.com/v3/videos" },
    },
    { name: "Shape result", type: "n8n-nodes-base.code", parameters: {} },
    {
      name: "Signed callback",
      type: "n8n-nodes-base.httpRequest",
      parameters: { url: "={{ $json.callbackUrl }}" },
    },
    { name: "Sticky", type: "n8n-nodes-base.stickyNote", parameters: {} },
  ],
  connections: {
    "Webhook trigger": { main: [[{ node: "Verify signature" }]] },
    "Verify signature": { main: [[{ node: "Signature valid?" }]] },
    "Signature valid?": { main: [[{ node: "HeyGen render" }]] },
    "HeyGen render": { main: [[{ node: "Shape result" }]] },
    "Shape result": { main: [[{ node: "Signed callback" }]] },
  },
};

describe("extractProcess", () => {
  const run = () =>
    extractProcess(fixture, {
      file: "n8n/workflows/demo.json",
      appNode: "app",
      n8nNode: "n8n",
      resolve: (raw) =>
        ({ "n8n-host:api.heygen.com": "heygen" })[raw as "n8n-host:api.heygen.com"] ?? null,
    });

  it("collapses code/if/sticky nodes and keeps only lane-crossing steps", () => {
    const p = run()?.process;
    expect(p?.steps.map((s) => s.kind)).toEqual(["trigger", "check", "call", "callback"]);
    expect(p?.steps.map((s) => s.lane)).toEqual(["app", "n8n", "heygen", "app"]);
    expect(p?.steps.some((s) => /Shape result|Sticky/.test(s.label))).toBe(false);
  });

  it("wires the collapsed chain and marks the callback as the return channel", () => {
    const p = run()?.process;
    expect(p?.edges).toEqual([
      { from: "proc.demo#trigger", to: "proc.demo#check", role: "main" },
      { from: "proc.demo#check", to: "proc.demo#heygen-render", role: "main" },
      { from: "proc.demo#heygen-render", to: "proc.demo#signed-callback", role: "return" },
    ]);
    expect(p?.lanes).toEqual(["app", "n8n", "heygen"]);
    expect(p?.trigger).toMatchObject({ kind: "webhook", from: "app", path: "demo" });
    expect(p?.return).toEqual({ to: "app", kind: "signed-callback" });
  });

  it("reports the host raw key so the meaning layer can be checked", () => {
    expect(run()?.rawKeys).toEqual(["n8n-host:api.heygen.com"]);
  });

  it("routes a stopAndError branch as an error edge", () => {
    const withError: Workflow = {
      nodes: [
        ...(fixture.nodes ?? []),
        { name: "Reject", type: "n8n-nodes-base.stopAndError", parameters: {} },
      ],
      connections: {
        ...fixture.connections,
        "Signature valid?": { main: [[{ node: "HeyGen render" }], [{ node: "Reject" }]] },
      },
    };
    const p = extractProcess(withError, {
      file: "n8n/workflows/demo.json",
      appNode: "app",
      n8nNode: "n8n",
      resolve: () => null,
    })?.process;
    expect(p?.edges).toContainEqual({
      from: "proc.demo#check",
      to: "proc.demo#reject",
      role: "error",
    });
  });
});

// --- the two commands ----------------------------------------------------

/** A minimal repo carrying one of each thing an extractor looks for. */
function repo(meaning?: Meaning): string {
  const root = mkdtempSync(join(tmpdir(), "map-"));
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  web:\n    image: node:22\n    depends_on:\n      - postgres\n  postgres:\n    image: pgvector/pgvector:pg17\n    networks: [internal]\n",
  );
  mkdirSync(join(root, "server/src/domain/eventOrg"), { recursive: true });
  writeFileSync(join(root, "server/src/domain/index.ts"), "export {};\n");
  mkdirSync(join(root, "server/src/adapters"), { recursive: true });
  writeFileSync(join(root, "server/src/adapters/payment.ts"), "const m = PAYMENT_MODE;\n");
  writeFileSync(
    join(root, "server/src/app.ts"),
    'app.use(stripeRouter);\napp.post("/api/webhooks/stripe", handler);\n',
  );
  if (meaning !== undefined) {
    mkdirSync(join(root, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(root, "docs/architecture/meaning.json"),
      JSON.stringify(meaning, null, 2) + "\n",
    );
  }
  return root;
}

const complete: Meaning = {
  schema_version: 1,
  project: { id: "demo", label: "demo app", modulesRoot: "server/src/domain" },
  raw: { "adapter:payment": "stripe", "route:POST /api/webhooks/stripe": "stripe" },
  nodes: { stripe: { label: "Stripe", type: "external" } },
};

const ctxFor = (root: string, args: string[], dryRun = false): CommandContext => ({
  flags: { human: false, dryRun },
  args,
  repoRoot: root,
});

describe("map check", () => {
  it("is green when the meaning layer answers every raw key and names every node", () => {
    const result = runMap(ctxFor(repo(complete), ["check"]));
    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data).toMatchObject({
      project: "demo",
      unmapped: { raw: [], nodes: [] },
      processes: 0,
    });
    // web + postgres + the app node + one module + stripe
    expect(result.data?.nodes).toBe(5);
  });

  it("is red on an unmapped raw key and names the key and the file to edit", () => {
    const root = repo({ ...complete, raw: { "adapter:payment": "stripe" } });
    const result = runMap(ctxFor(root, ["check"]));
    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      unmapped: { raw: ["route:POST /api/webhooks/stripe"], nodes: [] },
    });
    expect(result.notes ?? []).toEqual([
      'add a mapping for "route:POST /api/webhooks/stripe" in docs/architecture/meaning.json',
    ]);
  });

  it("is red on a node the meaning layer maps but does not describe", () => {
    const root = repo({ ...complete, nodes: {} });
    const result = runMap(ctxFor(root, ["check"]));
    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.data).toMatchObject({ unmapped: { raw: [], nodes: ["stripe"] } });
    expect((result.notes ?? [])[0]).toBe(
      'add display facts for the node "stripe" in docs/architecture/meaning.json',
    );
  });

  it("writes nothing — it is the gate phase, not the producer", () => {
    const root = repo(complete);
    runMap(ctxFor(root, ["check"]));
    expect(existsSync(join(root, MAP_OUT))).toBe(false);
  });
});

describe("map extract", () => {
  it("writes the four model files and stays green with unmapped keys", () => {
    const root = repo({ ...complete, raw: {} });
    const result = runMap(ctxFor(root, ["extract"]));
    expect(result.ok).toBe(true);
    expect(result.exit).toBeUndefined(); // dispatcher maps ok -> exit 0
    expect(result.data).toMatchObject({ out: MAP_OUT, project: "demo" });
    expect(result.data?.unmapped).toEqual({
      raw: ["adapter:payment", "route:POST /api/webhooks/stripe"],
      nodes: [],
    });

    const out = join(root, MAP_OUT);
    for (const file of ["model.json", "unmapped.json", "meaning.json"])
      expect(existsSync(join(out, file))).toBe(true);
    expect(existsSync(join(out, "processes"))).toBe(true);
    const model = JSON.parse(readFileSync(join(out, "model.json"), "utf8")) as {
      project: string;
      counts: Record<string, number>;
      extractors: Record<string, number>;
    };
    expect(model.project).toBe("demo");
    expect(model.counts).toMatchObject({ services: 2, modules: 1, adapters: 1, inbound_routes: 1 });
    expect(Object.keys(model.extractors)).toEqual(["compose", "modules", "adapters", "routes"]);
  });

  it("honours --out and --project and leaves the default directory alone", () => {
    const root = repo({ ...complete, project: {} });
    const out = mkdtempSync(join(tmpdir(), "map-out-"));
    const result = runMap(ctxFor(root, ["extract", "--out", out, "--project", "other"]));
    expect(result.data).toMatchObject({ project: "other", out });
    expect(existsSync(join(out, "model.json"))).toBe(true);
    expect(existsSync(join(root, MAP_OUT))).toBe(false);
  });

  it("writes nothing under --dry-run", () => {
    const root = repo(complete);
    const result = runMap(ctxFor(root, ["extract"], true));
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, MAP_OUT))).toBe(false);
    expect((result.notes ?? [])[0]).toContain("dry run");
  });
});

describe("map preconditions", () => {
  it("exit 4 without a meaning layer, naming the path and the norm", () => {
    const root = repo();
    expect(() => runMap(ctxFor(root, ["check"]))).toThrowError(
      /no meaning layer at .*PROC-SPEC-002/,
    );
    try {
      runMap(ctxFor(root, ["extract"]));
    } catch (error) {
      expect(error).toMatchObject({ exit: EXIT.PRECONDITION, field: "--meaning" });
    }
  });

  it("exit 4 for a meaning layer without a project id and no --project", () => {
    const root = repo({ ...complete, project: {} });
    try {
      runMap(ctxFor(root, ["check"]));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ exit: EXIT.PRECONDITION, field: "--project" });
    }
  });

  it("exit 4 for a missing or unknown subcommand, and for an unknown option", () => {
    const root = repo(complete);
    for (const args of [[], ["render"], ["check", "--depth", "2"]]) {
      try {
        runMap(ctxFor(root, args));
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ exit: EXIT.PRECONDITION });
      }
    }
  });

  it("reads a repo named as a positional, with the meaning layer from elsewhere", () => {
    const root = repo();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "map-meaning-")), "seed.json");
    writeFileSync(elsewhere, JSON.stringify(complete));
    const result = runMap(ctxFor(process.cwd(), ["check", root, "--meaning", elsewhere]));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ project: "demo", meaning: elsewhere });
  });
});
