import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { randomBytes } from 'node:crypto';
import {
  candidateControlHeader,
  isResourceExhaustion,
  validateVisualEvidence,
  VisualQaEngine,
} from './engine.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(
  () =>
    new Promise<void>((resolve) => {
      Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((closed) => server.close(() => closed()))),
      ).then(() => {
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
        resolve();
      });
    }),
);

describe('retrying only a resource-level capture failure', () => {
  it('recognises a request the machine could not make', () => {
    // The failure this exists for: a cold context re-fetches the whole dev
    // module graph per scenario, the machine runs out of sockets, and the app
    // never boots -- which then surfaces as a selector timeout.
    expect(
      isResourceExhaustion({
        networkFailures: ['GET http://127.0.0.1:52325/src/App.tsx — net::ERR_NO_BUFFER_SPACE'],
      }),
    ).toBe(true);
    expect(
      isResourceExhaustion({
        consoleErrors: ['Failed to load resource: net::ERR_NO_BUFFER_SPACE'],
      }),
    ).toBe(true);
  });

  it('needs every recorded entry to be resource-level, not just one', () => {
    // A scenario that failed for a genuine UI reason and merely happens to also
    // record a resource error must not be retried on the strength of the
    // incidental entry: a retry that passes would drop detection of an
    // intermittent defect from every run to every other run.
    expect(
      isResourceExhaustion({
        networkFailures: ['GET /src/App.tsx — net::ERR_NO_BUFFER_SPACE'],
        consoleErrors: ['TypeError: cannot read properties of undefined'],
      }),
    ).toBe(false);
  });

  it('treats a reset connection as evidence about the candidate', () => {
    // The connection was established and then torn down, which a candidate that
    // crashes mid-response or resets a stream produces itself.
    expect(
      isResourceExhaustion({ networkFailures: ['GET /api/events — net::ERR_CONNECTION_RESET'] }),
    ).toBe(false);
  });

  it('never retries away evidence about the candidate', () => {
    // A 404, a 500, a script error or a plain timeout are all things the
    // candidate did. Retrying any of them would hide a real defect.
    expect(isResourceExhaustion({ networkFailures: ['GET /src/App.tsx — 404 Not Found'] })).toBe(
      false,
    );
    expect(isResourceExhaustion({ networkFailures: ['GET /api/jobs — 500'] })).toBe(false);
    expect(
      isResourceExhaustion({ consoleErrors: ['TypeError: cannot read properties of undefined'] }),
    ).toBe(false);
    expect(isResourceExhaustion({})).toBe(false);
  });
});

describe('deterministic visual interactions', () => {
  it('captures desktop/mobile after goto, fill, click, wait and screenshot steps', async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><input id="name"><button id="go" onclick="document.body.dataset.ready='yes'">Go</button>`,
      );
    });
    servers.push(server);
    const activeServer = server;
    await new Promise<void>((resolve) => activeServer.listen(0, '127.0.0.1', resolve));
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-'));
    roots.push(root);
    const config = loadConfig({ home: root, dbPath: ':memory:' });
    const db = openDb(config);
    try {
      db.prepare(
        `INSERT INTO projects
          (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run('project-tools', 'tools-fixture', root, 'main', '{}', '{}', 0, '{}', 'now', 'now');
      db.prepare(
        `INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        'job-tools',
        'project-tools',
        'capture tools',
        'capture tools',
        'visual_qa',
        'running',
        'now',
        'now',
      );
      const shots = await new VisualQaEngine(db, path.join(root, 'artifacts')).capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        scenarios: [
          {
            name: 'tools',
            route: '/',
            interactions: [
              { action: 'goto', route: '/' },
              { action: 'fill', selector: '#name', value: 'Jarvis' },
              { action: 'click', selector: '#go' },
              { action: 'wait', selector: 'body[data-ready="yes"]' },
              { action: 'screenshot', name: 'ready' },
            ],
            viewports: ['desktop', 'mobile'],
          },
        ],
        headRef: 'a'.repeat(40),
      });
      expect(shots.map((shot) => shot.viewport)).toEqual(['desktop', 'mobile']);
      expect(shots.every((shot) => shot.scenarioName === 'tools')).toBe(true);
      expect(shots.every((shot) => shot.status === 'captured' && shot.screenshotPath)).toBe(true);
      expect(shots.every((shot) => validateVisualEvidence(shot.screenshotPath))).toBe(true);
      expect(
        db
          .prepare('SELECT DISTINCT scenario_name,head_ref FROM visual_qa WHERE job_id=?')
          .all('job-tools'),
      ).toEqual([{ scenario_name: 'tools', head_ref: 'a'.repeat(40) }]);
      expect(
        fs
          .readdirSync(path.dirname(shots[0]?.screenshotPath ?? ''))
          .filter((name) => name.startsWith('ready-')),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  }, 60_000);

  it('runs the declared per-viewport interactions instead of the shared ones', async () => {
    // Mobile hides the sidebar behind a real drawer, exactly as a candidate UI
    // may. Clicking the desktop nav on mobile would time out, so the two paths
    // must be declared separately rather than forced through hidden elements.
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><style>@media (max-width: 800px){#desktop-nav{display:none}}</style>` +
          `<button id="desktop-nav" onclick="document.body.dataset.view='jobs'">Jobs</button>` +
          `<button id="drawer-open" onclick="document.body.dataset.drawer='open'">Menu</button>` +
          // A zero-size element is never "visible" to Playwright, so the drawer
          // needs real extent for the wait step to mean what it says.
          `<div id="drawer" style="display:none;width:200px;height:60px">Navigation</div>` +
          `<button id="mobile-nav" onclick="document.body.dataset.view='jobs'">Jobs</button>` +
          `<script>new MutationObserver(()=>{if(document.body.dataset.drawer==='open')` +
          `document.getElementById('drawer').style.display='block'}).observe(document.body,{attributes:true})</script>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-'));
    roots.push(root);
    const db = openDb(loadConfig({ home: root, dbPath: ':memory:' }));
    try {
      const shots = await new VisualQaEngine(db, path.join(root, 'artifacts')).capture({
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        scenarios: [
          {
            name: 'jobs',
            route: '/',
            interactions: [{ action: 'click', selector: '#desktop-nav' }],
            viewportInteractions: {
              mobile: [
                { action: 'click', selector: '#drawer-open' },
                { action: 'wait', selector: '#drawer:visible' },
                { action: 'click', selector: '#mobile-nav' },
              ],
            },
            expectedSelector: 'body[data-view="jobs"]',
            viewports: ['desktop', 'mobile'],
          },
        ],
      });
      expect(shots.map((shot) => shot.status)).toEqual(['captured', 'captured']);
      expect(shots.map((shot) => shot.error)).toEqual([null, null]);
    } finally {
      db.close();
    }
  });

  it.each([
    ['initial redirect', '/redirect-cross', []],
    ['link click', '/click', [{ action: 'click', selector: '#escape' }]],
    ['form navigation', '/form', [{ action: 'click', selector: '#submit' }]],
    ['JavaScript navigation', '/js', [{ action: 'click', selector: '#escape' }]],
  ] as const)('fails a scenario on cross-origin %s', async (_name, route, interactions) => {
    const target = http.createServer((_request, response) => response.end('<h1>escaped</h1>'));
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target did not bind');
    const escaped = `http://127.0.0.1:${targetAddress.port}/escaped`;
    const candidate = http.createServer((request, response) => {
      if (request.url === '/redirect-cross') {
        response.writeHead(302, { location: escaped }).end();
      } else if (request.url === '/click') {
        response.end(`<a id="escape" href="${escaped}">escape</a>`);
      } else if (request.url === '/form') {
        response.end(`<form action="${escaped}"><button id="submit">submit</button></form>`);
      } else {
        response.end(`<button id="escape" onclick="location.href='${escaped}'">escape</button>`);
      }
    });
    servers.push(candidate);
    await new Promise<void>((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('candidate did not bind');
    const { engine, db } = visualFixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: [route],
        scenarios: [
          { name: _name, route, interactions: [...interactions], viewports: ['desktop'] },
        ],
      });
      expect(shots[0]?.status).toBe('failed');
      expect(shots[0]?.screenshotPath).toBeNull();
    } finally {
      db.close();
    }
  });

  it.each([
    ['delayed redirect', `location.href='/bounce'`],
    ['delayed JavaScript navigation', `location.href=ESCAPED`],
    [
      'delayed form navigation',
      `const f=document.createElement('form');f.action=ESCAPED;document.body.append(f);f.requestSubmit()`,
    ],
    ['delayed popup', `window.open(ESCAPED)`],
  ])('permanently rejects a %s before the foreign document is dispatched', async (name, action) => {
    let foreignRequests = 0;
    const target = http.createServer((_request, response) => {
      foreignRequests++;
      response.end('<h1>escaped</h1>');
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target did not bind');
    const escaped = `http://127.0.0.1:${targetAddress.port}/escaped`;
    const candidate = http.createServer((request, response) => {
      if (request.url === '/bounce')
        return void response.writeHead(302, { location: escaped }).end();
      const handler =
        name === 'delayed popup'
          ? `const popup=window.open('about:blank');setTimeout(()=>popup.location.href=ESCAPED,10)`
          : `setTimeout(()=>{${action}},${name === 'delayed JavaScript navigation' ? 100 : 10})`;
      response.end(
        `<button id="go">go</button><script>const ESCAPED=${JSON.stringify(escaped)};` +
          `go.onclick=()=>{${handler}}</script>`,
      );
    });
    servers.push(candidate);
    await new Promise<void>((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('candidate did not bind');
    const { engine, db, artifactsDir } = visualFixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        scenarios: [
          {
            name,
            route: '/',
            interactions: [
              { action: 'click', selector: '#go' },
              ...(name === 'delayed JavaScript navigation'
                ? ([{ action: 'screenshot', name: 'pre-violation' }] as const)
                : []),
            ],
            viewports: ['desktop'],
          },
        ],
      });
      expect(foreignRequests).toBe(0);
      expect(shots[0]?.status).toBe('failed');
      expect(shots[0]?.screenshotPath).toBeNull();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM visual_qa WHERE status='captured'").get(),
      ).toEqual({ count: 0 });
      expect(findPngs(artifactsDir)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('invalidates navigation after the screenshot file is written but before acceptance', async () => {
    let foreignRequests = 0;
    const target = http.createServer((_request, response) => {
      foreignRequests++;
      response.end('escaped');
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('target did not bind');
    const escaped = `http://127.0.0.1:${targetAddress.port}/escaped`;
    const candidate = http.createServer((_request, response) => response.end('<h1>candidate</h1>'));
    servers.push(candidate);
    await new Promise<void>((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('candidate did not bind');
    const { engine, db, artifactsDir } = visualFixture(async (page, screenshotPath) => {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.evaluate((url) => {
        location.href = url;
      }, escaped);
    });
    try {
      const shots = await engine.capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        scenarios: [
          {
            name: 'screenshot-race',
            route: '/',
            viewports: ['desktop'],
          },
        ],
      });
      expect(foreignRequests).toBe(0);
      expect(shots[0]?.status).toBe('failed');
      expect(shots[0]?.screenshotPath).toBeNull();
      expect(findPngs(artifactsDir)).toEqual([]);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM visual_qa WHERE status='captured'").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('allows delayed same-origin navigation', async () => {
    const candidate = http.createServer((request, response) => {
      response.end(
        request.url === '/final'
          ? '<h1>same origin</h1>'
          : `<button id="go" onclick="setTimeout(()=>location.href='/final',10)">go</button>`,
      );
    });
    servers.push(candidate);
    await new Promise<void>((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('candidate did not bind');
    const { engine, db } = visualFixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        scenarios: [
          {
            name: 'same-origin delayed',
            route: '/',
            interactions: [{ action: 'click', selector: '#go' }],
            viewports: ['desktop'],
          },
        ],
      });
      expect(shots[0]?.status).toBe('captured');
    } finally {
      db.close();
    }
  });

  it('allows a same-origin redirect', async () => {
    const candidate = http.createServer((request, response) => {
      if (request.url === '/redirect-same') response.writeHead(302, { location: '/final' }).end();
      else response.end('<h1>same origin</h1>');
    });
    servers.push(candidate);
    await new Promise<void>((resolve) => candidate.listen(0, '127.0.0.1', resolve));
    const address = candidate.address();
    if (!address || typeof address === 'string') throw new Error('candidate did not bind');
    const { engine, db } = visualFixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-tools',
        projectId: 'project-tools',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/redirect-same'],
        viewports: ['desktop'],
      });
      expect(shots[0]?.status).toBe('captured');
    } finally {
      db.close();
    }
  });

  it.each(['..\\..\\escape', '../../escape', '..%2f..%2fescape', '..\\../escape'])(
    'rejects an unowned artifact identity %s before browser launch',
    async (identity) => {
      const { engine, db, artifactsDir } = visualFixture();
      const outside = path.resolve(artifactsDir, '..', '..', 'escape');
      const existed = fs.existsSync(outside);
      try {
        await expect(
          engine.capture({
            jobId: identity,
            baseUrl: 'http://127.0.0.1:1',
            routes: ['/'],
          }),
        ).rejects.toThrow('job does not exist');
        expect(fs.existsSync(outside)).toBe(existed);
      } finally {
        db.close();
      }
    },
  );

  it('rejects a mismatched existing job and project before creating artifacts', async () => {
    const { engine, db, artifactsDir } = visualFixture();
    try {
      db.prepare(
        `INSERT INTO projects
          (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run('other-project', 'other', '.', 'main', '{}', '{}', 0, '{}', 'now', 'now');
      await expect(
        engine.capture({
          jobId: 'job-tools',
          projectId: 'other-project',
          baseUrl: 'http://127.0.0.1:1',
          routes: ['/'],
        }),
      ).rejects.toThrow('job/project mismatch');
      expect(fs.existsSync(artifactsDir)).toBe(false);
    } finally {
      db.close();
    }
  });
});

function visualFixture(
  captureScreenshot?: NonNullable<ConstructorParameters<typeof VisualQaEngine>[3]>,
): {
  engine: VisualQaEngine;
  db: ReturnType<typeof openDb>;
  artifactsDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-confined-'));
  roots.push(root);
  const config = loadConfig({ home: root, dbPath: ':memory:' });
  const db = openDb(config);
  db.prepare(
    `INSERT INTO projects
      (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('project-tools', 'tools-fixture', root, 'main', '{}', '{}', 0, '{}', 'now', 'now');
  db.prepare(
    `INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('job-tools', 'project-tools', 'capture', 'capture', 'visual_qa', 'running', 'now', 'now');
  return {
    engine: new VisualQaEngine(db, config.artifactsDir, undefined, captureScreenshot),
    db,
    artifactsDir: config.artifactsDir,
  };
}

function findPngs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name);
}

describe('candidate-runtime authenticated visual QA', () => {
  const CANDIDATE_SCENARIOS = () => [
    {
      name: 'chat-workspace',
      route: '/',
      expectedSelector: "[data-testid='chat-view']",
      viewports: ['desktop' as const, 'mobile' as const],
    },
    {
      name: 'tools',
      route: '/',
      interactions: [
        { action: 'click' as const, selector: "[data-testid='nav-tools']" },
        { action: 'wait' as const, selector: "[data-testid='tools-view']" },
      ],
      viewportInteractions: {
        mobile: [
          { action: 'click' as const, selector: "[data-testid='mobile-drawer-open']" },
          { action: 'click' as const, selector: "[data-testid='nav-tools']" },
          { action: 'wait' as const, selector: "[data-testid='tools-view']" },
        ],
      },
      expectedSelector: "[data-testid='tools-view']",
      viewports: ['desktop' as const, 'mobile' as const],
    },
  ];

  /** A stand-in for the candidate UI: locked until /api/auth/status authenticates. */
  async function candidateApp(credential: string) {
    const seen: Array<{ url: string; control: string | undefined }> = [];
    let locked = 0;
    const server = http.createServer((request, response) => {
      seen.push({
        url: request.url ?? '',
        control: request.headers['x-jarvis-control'] as string | undefined,
      });
      if (request.url?.startsWith('/api/auth/status')) {
        if (request.headers['x-jarvis-control'] !== credential) {
          locked += 1;
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end('{"error":"human control authentication required"}');
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end('{"authenticated":true,"paired":true}');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><div id="root">booting</div><script>
        (async () => {
          const root = document.getElementById('root');
          const status = await fetch('/api/auth/status');
          if (status.status !== 200) { root.innerHTML = '<h1>Human control locked</h1>'; return; }
          root.innerHTML = "<div data-testid='chat-view'><h1>Chat</h1>" +
            "<button data-testid='mobile-drawer-open'>Menu</button>" +
            "<button data-testid='nav-tools'>Tools</button></div>";
          const nav = document.querySelector("[data-testid='nav-tools']");
          if (innerWidth < 600) nav.disabled = true;
          document.querySelector("[data-testid='mobile-drawer-open']").addEventListener('click', () => {
            nav.disabled = false;
          });
          document.querySelector("[data-testid='nav-tools']").addEventListener('click', () => {
            root.innerHTML = "<div data-testid='tools-view'><h1>Tools</h1></div>";
          });
        })();
        </script>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return { baseUrl: `http://127.0.0.1:${address.port}`, seen, locked: () => locked };
  }

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-auth-'));
    roots.push(root);
    const db = openDb(loadConfig({ home: root, dbPath: ':memory:' }));
    db.prepare(
      `INSERT INTO projects
        (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('project-candidate', 'candidate', root, 'main', '{}', '{}', 1, '{}', 'now', 'now');
    db.prepare(
      `INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('job-candidate', 'project-candidate', 'qa', 'qa', 'visual_qa', 'running', 'now', 'now');
    return { db, engine: new VisualQaEngine(db, path.join(root, 'artifacts')) };
  }

  it('attaches the control header to candidate-origin requests only', () => {
    const credential = randomBytes(32).toString('base64url');
    const origin = 'http://127.0.0.1:41234';
    expect(candidateControlHeader(`${origin}/api/auth/status`, origin, credential)).toEqual({
      'x-jarvis-control': credential,
    });
    // Foreign origins — including the same host on another port — get nothing.
    expect(
      candidateControlHeader('http://127.0.0.1:41235/x.js', origin, credential),
    ).toBeUndefined();
    expect(
      candidateControlHeader('http://localhost:41234/x.js', origin, credential),
    ).toBeUndefined();
    expect(
      candidateControlHeader('https://cdn.example.com/x.js', origin, credential),
    ).toBeUndefined();
    expect(candidateControlHeader('not a url', origin, credential)).toBeUndefined();
    // Real Jarvis runs Visual QA without a candidate credential: never attached.
    expect(candidateControlHeader(`${origin}/`, origin, null)).toBeUndefined();
  });

  it('captures the authenticated candidate UI for every scenario and viewport', async () => {
    const credential = randomBytes(32).toString('base64url');
    const app = await candidateApp(credential);
    const { db, engine } = fixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-candidate',
        projectId: 'project-candidate',
        baseUrl: app.baseUrl,
        controlCredential: credential,
        routes: ['/'],
        scenarios: CANDIDATE_SCENARIOS(),
        headRef: 'b'.repeat(40),
      });

      expect(shots.filter((shot) => shot.status === 'captured')).toHaveLength(4);
      expect(shots.filter((shot) => shot.status === 'failed')).toHaveLength(0);
      expect(shots.map((shot) => `${shot.scenarioName}/${shot.viewport}`)).toEqual([
        'chat-workspace/desktop',
        'chat-workspace/mobile',
        'tools/desktop',
        'tools/mobile',
      ]);
      expect(shots.every((shot) => validateVisualEvidence(shot.screenshotPath))).toBe(true);
      // No 401 and no console errors: the pairing screen was never rendered, so
      // the screenshots can only show the authenticated Chat/Tools UI.
      expect(shots.flatMap((shot) => shot.networkFailures)).toEqual([]);
      expect(shots.flatMap((shot) => shot.consoleErrors)).toEqual([]);
      expect(app.locked()).toBe(0);
      // Every candidate-origin request carried the credential — document included.
      expect(app.seen.length).toBeGreaterThan(0);
      expect(app.seen.every((entry) => entry.control === credential)).toBe(true);
      // And no evidence row records it.
      expect(JSON.stringify(shots)).not.toContain(credential);
    } finally {
      db.close();
    }
  }, 120_000);

  it('still photographs the pairing screen when no candidate credential is supplied', async () => {
    const app = await candidateApp(randomBytes(32).toString('base64url'));
    const { db, engine } = fixture();
    try {
      const shots = await engine.capture({
        jobId: 'job-candidate',
        projectId: 'project-candidate',
        baseUrl: app.baseUrl,
        routes: ['/'],
        scenarios: CANDIDATE_SCENARIOS(),
        headRef: 'c'.repeat(40),
      });
      expect(app.seen.every((entry) => entry.control === undefined)).toBe(true);
      expect(app.locked()).toBeGreaterThan(0);
      expect(shots.flatMap((shot) => shot.networkFailures).some((f) => f.startsWith('401 '))).toBe(
        true,
      );
      // Tools cannot be reached from the locked screen.
      expect(
        shots
          .filter((shot) => shot.scenarioName === 'tools')
          .every((shot) => shot.status === 'failed'),
      ).toBe(true);
    } finally {
      db.close();
    }
  }, 120_000);
});
