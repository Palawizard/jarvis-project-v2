import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { nowIso } from '../ids.js';

const BOOTSTRAP_TTL_MS = 10 * 60_000;

/** Human authority: an out-of-band, one-use bootstrap and a persisted token hash. */
export class HumanControlAuth {
  #bootstrapHash: Buffer | null = null;
  #bootstrapExpiresAt = 0;

  constructor(private readonly db: Db) {}

  /** Return the raw bootstrap exactly once to the controlling terminal. */
  createBootstrap(): string {
    const secret = randomBytes(32).toString('base64url');
    this.#bootstrapHash = digest(secret);
    this.#bootstrapExpiresAt = Date.now() + BOOTSTRAP_TTL_MS;
    return secret;
  }

  pair(bootstrap: string): string | null {
    const supplied = digest(bootstrap);
    const valid =
      this.#bootstrapHash !== null &&
      Date.now() <= this.#bootstrapExpiresAt &&
      timingSafeEqual(supplied, this.#bootstrapHash);
    if (!valid) return null;

    this.#bootstrapHash = null;
    this.#bootstrapExpiresAt = 0;
    const credential = randomBytes(32).toString('base64url');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO human_control (id, credential_hash, paired_at, updated_at)
         VALUES ('primary',?,?,?)
         ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash,
           paired_at=excluded.paired_at, updated_at=excluded.updated_at`,
      )
      .run(digest(credential).toString('hex'), now, now);
    return credential;
  }

  /**
   * Candidate runtimes have no human to pair with, so Visual QA would only ever
   * photograph the pairing screen. The parent generates one ephemeral credential
   * per candidate runtime and hands the child nothing but its SHA-256 hash; this
   * seeds the isolated candidate JARVIS_HOME with that hash so the candidate API
   * accepts exactly that credential and nothing else. The real ~/.jarvis row is
   * never read, copied or reused, and knowing the hash does not authenticate.
   */
  initCandidateVisualQa(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.JARVIS_CANDIDATE_RUNTIME !== '1') return false;
    const hash = env.JARVIS_CANDIDATE_QA_CREDENTIAL_HASH?.toLowerCase();
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO human_control (id, credential_hash, paired_at, updated_at)
         VALUES ('primary',?,?,?)
         ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash,
           paired_at=excluded.paired_at, updated_at=excluded.updated_at`,
      )
      .run(hash, now, now);
    return true;
  }

  authenticated(credential: string | undefined): boolean {
    if (!credential) return false;
    const row = this.db
      .prepare("SELECT credential_hash FROM human_control WHERE id='primary'")
      .get() as { credential_hash?: string | null } | undefined;
    if (!row?.credential_hash || !/^[a-f0-9]{64}$/.test(row.credential_hash)) return false;
    return timingSafeEqual(digest(credential), Buffer.from(row.credential_hash, 'hex'));
  }

  paired(): boolean {
    const row = this.db
      .prepare("SELECT credential_hash FROM human_control WHERE id='primary'")
      .get() as { credential_hash?: string | null } | undefined;
    return Boolean(row?.credential_hash);
  }

  revoke(): void {
    this.db
      .prepare("UPDATE human_control SET credential_hash=NULL, updated_at=? WHERE id='primary'")
      .run(nowIso());
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
