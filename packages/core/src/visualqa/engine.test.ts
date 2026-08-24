import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { VisualQaEngine } from './engine.js';

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
