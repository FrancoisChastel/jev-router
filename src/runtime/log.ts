import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const REPORT_EVERY = 50;

/**
 * Append-only JSONL writer. Writes are serialized in call order, never throw into the caller,
 * count their failures, and report the first failure and then every fiftieth on stderr.
 * `flush()` resolves once every queued write has settled, for graceful shutdown.
 */
export class JsonlLogger {
  private chain: Promise<void> = Promise.resolve();
  private dirReady = false;
  private failureCount = 0;

  constructor(private readonly path: string) {}

  get failures(): number {
    return this.failureCount;
  }

  write(record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain.then(() => this.append(line)).catch((e: unknown) => this.report(e));
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, line);
  }

  private report(e: unknown): void {
    this.failureCount += 1;
    if (this.failureCount === 1 || this.failureCount % REPORT_EVERY === 0) {
      console.error(
        `jev-router: cannot write decision log at ${this.path} (${this.failureCount} failed): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
