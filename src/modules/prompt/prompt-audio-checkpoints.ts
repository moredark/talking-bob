import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AudioCheckpoint, PromptAudioCheckpointStore, PromptAudioPreparationError } from "./prompt-audio-preparation";

export class FilePromptAudioCheckpoints implements PromptAudioCheckpointStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  async withLock<T>(run: () => Promise<T>): Promise<T> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "prepare.lock");
    const lock = await open(path, "wx", 0o600).catch(() => {
      throw new PromptAudioPreparationError("cache_locked_or_not_writable");
    });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await lock.sync();
      // Persist newly created cache directories (and their parent links), not just file contents.
      const lastDirectory = created ? dirname(created) : this.directory;
      let current = this.directory;
      while (true) {
        await this.syncDirectory(current);
        if (current === lastDirectory || current === dirname(current)) break;
        current = dirname(current);
      }
      return await run();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }

  async read(key: string): Promise<AudioCheckpoint | null> {
    const path = this.path(key);
    let raw: string;
    try {
      if ((await stat(path)).size > 3 * 1024 * 1024) throw new PromptAudioPreparationError("checkpoint_too_large");
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value = JSON.parse(raw) as AudioCheckpoint;
      if (value.version !== 1 || value.key !== key || typeof value.promptId !== "string"
        || !["synthesizing", "ready", "uploading", "uploaded"].includes(value.phase)
        || (["ready", "uploading"].includes(value.phase) && (typeof value.audioBase64 !== "string" || !value.audioBase64))
        || (value.phase === "uploaded" && (typeof value.fileId !== "string" || !value.fileId.trim()))) {
        throw new Error();
      }
      return value;
    } catch { throw new PromptAudioPreparationError("invalid_checkpoint"); }
  }

  async write(value: AudioCheckpoint): Promise<void> {
    const path = this.path(value.key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    await this.syncDirectory(this.directory);
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new PromptAudioPreparationError("invalid_checkpoint_key");
    return join(this.directory, `${key}.json`);
  }
}
