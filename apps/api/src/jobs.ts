import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AnalyzeRequest, JobItem, JobRequest, JobResponse } from '@jsminer/contracts';
import type { AnalysisEngine } from './analysis.ts';
import type { ServiceConfig } from './config.ts';
import { ServiceError } from './errors.ts';

type JobRow = {
  id: string;
  project: string;
  status: JobResponse['status'];
  created: number;
  deadline: number;
  expires: number;
  turn: number;
};
const terminal = ['completed', 'timed_out', 'cancelled', 'interrupted'];
const DAY = 86400000;

/** Durable metadata and bounded pending inputs; workers and artifact ownership stay in the engine. */
export class JobQueue {
  private closing = false;
  private failed = false;
  private readonly running = new Map<
    string,
    { job: string; controller: AbortController; task: Promise<void> }
  >();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly engine: AnalysisEngine,
    private readonly config: ServiceConfig,
    private readonly now = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, status TEXT NOT NULL,
      created INTEGER NOT NULL, deadline INTEGER NOT NULL, expires INTEGER NOT NULL,
      turn INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS job_items (
      job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
      status TEXT NOT NULL, request TEXT, handle TEXT, error_code TEXT,
      PRIMARY KEY(job,idx)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires);
    CREATE INDEX IF NOT EXISTS jobs_active ON jobs(status,deadline);
    CREATE INDEX IF NOT EXISTS job_items_ready ON job_items(status,job,idx);
    INSERT OR IGNORE INTO schema_migrations VALUES (4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    BEGIN IMMEDIATE;
    UPDATE job_items SET status=CASE WHEN status='running' THEN 'failed' ELSE 'skipped' END,
      request=NULL,error_code='service_restarted' WHERE status IN ('queued','running');
    UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running','cancelling');
    COMMIT;`);
    this.purge();
    this.timer = setInterval(() => this.pump(), 25);
    this.timer.unref();
  }
  get healthy() {
    return !this.failed && !this.closing;
  }
  private items(id: string): JobItem[] {
    return this.db
      .prepare(
        'SELECT idx AS "index",status,handle,error_code FROM job_items WHERE job=? ORDER BY idx',
      )
      .all(id) as unknown as JobItem[];
  }
  private lookup(project: string, id: string): JobRow {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND project=?').get(id, project) as
      | JobRow
      | undefined;
    if (!row) throw new ServiceError(404, 'not_found');
    if (row.expires <= this.now())
      throw new ServiceError(this.now() >= row.expires + DAY ? 404 : 410, 'job_expired');
    return row;
  }
  get(project: string, id: string): JobResponse {
    const row = this.lookup(project, id);
    return {
      id,
      status: row.status,
      created_at: new Date(row.created).toISOString(),
      deadline_at: new Date(row.deadline).toISOString(),
      expires_at: new Date(row.expires).toISOString(),
      items: this.items(id) as JobResponse['items'],
    };
  }
  result(project: string, id: string, index: number) {
    this.lookup(project, id);
    const item = this.db
      .prepare('SELECT handle FROM job_items WHERE job=? AND idx=?')
      .get(id, index);
    if (!item) throw new ServiceError(404, 'not_found');
    if (!item.handle) throw new ServiceError(409, 'result_unavailable');
    return this.engine.store.result(project, String(item.handle));
  }
  create(project: string, request: JobRequest): JobResponse {
    if (!this.healthy || !this.engine.healthy) throw new ServiceError(503, 'service_unavailable');
    const budget = request.budget_ms ?? Math.min(90000, this.config.jobs.max_budget_ms);
    if (budget > this.config.jobs.max_budget_ms) throw new ServiceError(422, 'job_budget_exceeded');
    for (const item of request.items)
      if (
        item.content !== undefined &&
        Buffer.byteLength(item.content) > this.config.budgets.script_bytes
      )
        throw new ServiceError(413, 'script_too_large');
    this.purge();
    const encoded = request.items.map((item) => JSON.stringify(item));
    const used = this.db
      .prepare(`SELECT
      (SELECT count(*) FROM jobs WHERE expires>?) AS jobs,
      (SELECT coalesce(sum(length(CAST(request AS BLOB))),0) + count(*)*512 FROM job_items) +
      (SELECT count(*)*8192 FROM jobs) AS bytes`)
      .get(this.now()) as { jobs: number; bytes: number };
    const size = encoded.reduce((n, item) => n + Buffer.byteLength(item) + 512, 8192);
    if (used.jobs >= this.config.jobs.max_jobs || used.bytes + size > this.config.jobs.max_bytes)
      throw new ServiceError(429, 'job_capacity');
    const id = `job_${randomUUID()}`,
      created = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO jobs(id,project,status,created,deadline,expires) VALUES (?,?,?,?,?,?)',
        )
        .run(
          id,
          project,
          'queued',
          created,
          created + budget,
          created + this.config.jobs.retention_ms,
        );
      const insert = this.db.prepare(
        "INSERT INTO job_items(job,idx,status,request) VALUES (?,?,'queued',?)",
      );
      encoded.forEach((item, index) => {
        insert.run(id, index, item);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(project, id);
  }
  cancel(project: string, id: string): JobResponse {
    const row = this.lookup(project, id);
    if (!terminal.includes(row.status)) {
      this.db.prepare("UPDATE jobs SET status='cancelling' WHERE id=?").run(id);
      this.skip(id, 'job_cancelled');
      for (const value of this.running.values()) if (value.job === id) value.controller.abort();
      this.finish(id);
    }
    return this.get(project, id);
  }
  private skip(id: string, code: string) {
    this.db
      .prepare(
        "UPDATE job_items SET status='skipped',error_code=?,request=NULL WHERE job=? AND status='queued'",
      )
      .run(code, id);
  }
  private finish(id: string) {
    if (this.closing) return;
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow;
    if (terminal.includes(row.status)) return;
    const states = this.items(id);
    if (states.some((item) => item.status === 'queued' || item.status === 'running')) return;
    const status =
      row.status === 'cancelling'
        ? 'cancelled'
        : row.deadline <= this.now()
          ? 'timed_out'
          : 'completed';
    this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, id);
  }
  private purge() {
    this.db
      .prepare(
        "DELETE FROM job_items WHERE job IN (SELECT id FROM jobs WHERE expires<=? AND status IN ('completed','timed_out','cancelled','interrupted'))",
      )
      .run(this.now());
    this.db
      .prepare(
        "DELETE FROM jobs WHERE expires<=? AND status IN ('completed','timed_out','cancelled','interrupted')",
      )
      .run(this.now() - DAY);
  }
  private fail() {
    this.failed = true;
    for (const value of this.running.values()) value.controller.abort();
  }
  private pump() {
    if (this.closing || this.failed) return;
    try {
      for (const row of this.db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','running','cancelling') AND (deadline<=? OR ?=0)",
        )
        .all(this.now(), Number(this.engine.healthy)) as JobRow[]) {
        if (row.deadline <= this.now()) this.skip(row.id, 'job_deadline');
        if (!this.engine.healthy) this.skip(row.id, 'service_unavailable');
        this.finish(row.id);
      }
      // Least recently dispatched job first; preserve input order within each job.
      while (this.engine.available > 0) {
        const row = this.db
          .prepare(`SELECT j.*,i.idx,i.request FROM jobs j JOIN job_items i ON i.job=j.id
          WHERE j.status IN ('queued','running') AND j.deadline>? AND i.status='queued'
          ORDER BY j.turn,j.created,j.id,i.idx LIMIT 1`)
          .get(this.now()) as (JobRow & { idx: number; request: string }) | undefined;
        if (!row) break;
        const controller = new AbortController(),
          key = `${row.id}:${row.idx}`;
        this.db
          .prepare("UPDATE job_items SET status='running',request=NULL WHERE job=? AND idx=?")
          .run(row.id, row.idx);
        this.db
          .prepare(
            "UPDATE jobs SET status='running',turn=(SELECT coalesce(max(turn),0)+1 FROM jobs) WHERE id=?",
          )
          .run(row.id);
        const task = this.run(row, controller)
          .catch(() => {
            this.fail();
          })
          .finally(() => this.running.delete(key));
        this.running.set(key, { job: row.id, controller, task });
      }
    } catch {
      this.fail();
    }
  }
  private async run(row: JobRow & { idx: number; request: string }, controller: AbortController) {
    try {
      const request = JSON.parse(row.request) as AnalyzeRequest;
      const result = await this.engine.analyze(
        row.project,
        request,
        controller.signal,
        row.deadline - this.now(),
      );
      this.db
        .prepare('UPDATE job_items SET status=?,handle=?,error_code=NULL WHERE job=? AND idx=?')
        .run(result.status, result.handle, row.id, row.idx);
    } catch (error) {
      const code =
        error instanceof ServiceError &&
        ['worker_cleanup_unconfirmed', 'storage_cleanup_unconfirmed'].includes(error.code)
          ? error.code
          : controller.signal.aborted
            ? this.closing
              ? 'service_stopped'
              : this.failed
                ? 'scheduler_failed'
                : 'job_cancelled'
            : error instanceof ServiceError
              ? error.code
              : 'analysis_failed';
      this.db
        .prepare("UPDATE job_items SET status='failed',error_code=? WHERE job=? AND idx=?")
        .run(code, row.id, row.idx);
    }
    this.finish(row.id);
  }
  abort() {
    this.closing = true;
    clearInterval(this.timer);
    for (const value of this.running.values()) value.controller.abort();
  }
  async close() {
    this.abort();
    await Promise.allSettled([...this.running.values()].map((value) => value.task));
    this.db.exec(`UPDATE job_items SET status='skipped',request=NULL,error_code='service_stopped' WHERE status='queued';
      UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running','cancelling');`);
  }
}
